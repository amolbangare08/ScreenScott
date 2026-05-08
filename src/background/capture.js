/**
 * Capture engines for ScreenScott.
 *
 * Three modes are exposed:
 *   - captureVisible()        : single-shot of the visible viewport via tabs API.
 *   - captureFullPageCDP()    : single-shot full page via Chrome DevTools Protocol.
 *   - captureFullPageStitch() : scroll-and-stitch fallback for restricted pages.
 *
 * The orchestration layer (service-worker.js) decides when to fall back from
 * CDP to stitch — these functions just do their job and throw on failure.
 */

import { sleep } from './util.js';

// Hard cap to avoid OffscreenCanvas allocation failures on extremely tall pages.
// 32767 is the max canvas dimension in most browsers; we leave headroom.
const MAX_CAPTURE_DIMENSION = 30000;

// captureVisibleTab is rate-limited to ~2 calls/sec. Use a generous gap
// to stay comfortably under the limit, especially during batch captures.
const STITCH_CAPTURE_GAP_MS = 1200;
const STITCH_SETTLE_MS = 350;

/* ─────────────────────────────────────────────────────────────────────────
   1. Visible-area capture
   ───────────────────────────────────────────────────────────────────────── */

export async function captureVisible(tab, format = 'png') {
  const opts = format === 'jpeg' ? { format: 'jpeg', quality: 100 } : { format: 'png' };
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, opts);
  if (!dataUrl) throw new Error('Browser returned an empty capture.');
  return dataUrl;
}

/* ─────────────────────────────────────────────────────────────────────────
   2. Full-page capture via Chrome DevTools Protocol
   ───────────────────────────────────────────────────────────────────────── */

export async function captureFullPageCDP(tab, format = 'png', { onProgress } = {}) {
  const target = { tabId: tab.id };
  const protocolVersion = '1.3';

  // Query the page's actual devicePixelRatio so we render at native resolution.
  // Failure is non-fatal — we fall back to 1.
  let dpr = 1;
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.devicePixelRatio || 1,
    });
    if (typeof result === 'number' && result > 0) dpr = result;
  } catch (_) { /* CSP-restricted; default DPR is fine */ }

  // Pre-trigger lazy-loaded content. Best-effort — failure is non-fatal.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: triggerLazyLoadInPage,
    });
  } catch (_) { /* CSP may block script injection; capture can still proceed */ }

  onProgress?.({ phase: 'attaching' });
  await chrome.debugger.attach(target, protocolVersion);

  try {
    await chrome.debugger.sendCommand(target, 'Page.enable');

    onProgress?.({ phase: 'measuring' });
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const content = metrics.cssContentSize ?? metrics.contentSize;
    if (!content) throw new Error('Could not read page layout metrics.');

    const cssWidth  = Math.max(1, Math.ceil(content.width));
    const cssHeight = Math.max(1, Math.ceil(content.height));
    const pxWidth   = Math.round(cssWidth  * dpr);
    const pxHeight  = Math.round(cssHeight * dpr);

    if (pxWidth > MAX_CAPTURE_DIMENSION || pxHeight > MAX_CAPTURE_DIMENSION) {
      throw new Error(
        `Page is too large to capture in one shot (${pxWidth}×${pxHeight}px). ` +
        `Maximum supported is ${MAX_CAPTURE_DIMENSION}px on either side.`
      );
    }

    onProgress?.({ phase: 'capturing' });
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format,
      quality: format === 'jpeg' ? 100 : undefined,
      captureBeyondViewport: true,
      fromSurface: true,
      optimizeForSpeed: false,
      clip: {
        x: 0,
        y: 0,
        width: cssWidth,
        height: cssHeight,
        scale: dpr,
      },
    });

    if (!result?.data) throw new Error('Capture returned no image data.');
    return {
      dataUrl: `data:image/${format};base64,${result.data}`,
      width: pxWidth,
      height: pxHeight,
    };
  } finally {
    try { await chrome.debugger.detach(target); } catch (_) { /* tab may have closed; non-fatal */ }
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   3. Full-page capture via scroll-and-stitch (fallback)
   ───────────────────────────────────────────────────────────────────────── */

export async function captureFullPageStitch(tab, format = 'png', { onProgress } = {}) {
  onProgress?.({ phase: 'preparing' });

  const [{ result: prep }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: prepareForStitch,
  });
  if (!prep) throw new Error('Could not measure the page.');

  const { totalWidth, totalHeight, viewportWidth, viewportHeight, dpr } = prep;
  const pxWidth  = Math.round(totalWidth  * dpr);
  const pxHeight = Math.round(totalHeight * dpr);

  if (pxWidth > MAX_CAPTURE_DIMENSION || pxHeight > MAX_CAPTURE_DIMENSION) {
    await restorePage(tab.id);
    throw new Error(
      `Page is too large to capture (${pxWidth}×${pxHeight}px). ` +
      `Maximum supported is ${MAX_CAPTURE_DIMENSION}px on either side.`
    );
  }

  // Pre-scroll to trigger lazy-loaded content.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: triggerLazyLoadInPage,
    });
  } catch (_) { /* non-fatal */ }

  const canvas = new OffscreenCanvas(pxWidth, pxHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    await restorePage(tab.id);
    throw new Error('Could not allocate a canvas for stitching.');
  }

  try {
    const cols = Math.max(1, Math.ceil(totalWidth / viewportWidth));
    const rows = Math.max(1, Math.ceil(totalHeight / viewportHeight));
    const totalSlices = cols * rows;
    let sliceIndex = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const requestedX = c * viewportWidth;
        const requestedY = r * viewportHeight;

        // Scroll and read back the *actual* scroll position — pages may clamp.
        const [{ result: scrollPos }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sx, sy) => {
            window.scrollTo(sx, sy);
            return { x: window.scrollX, y: window.scrollY };
          },
          args: [requestedX, requestedY],
        });

        await sleep(STITCH_SETTLE_MS);

        const sliceDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const blob = await (await fetch(sliceDataUrl)).blob();
        const bitmap = await createImageBitmap(blob);

        ctx.drawImage(
          bitmap,
          Math.round(scrollPos.x * dpr),
          Math.round(scrollPos.y * dpr),
        );
        bitmap.close();

        sliceIndex++;
        onProgress?.({ phase: 'stitching', current: sliceIndex, total: totalSlices });

        // Throttle to stay under captureVisibleTab's rate limit.
        if (sliceIndex < totalSlices) await sleep(STITCH_CAPTURE_GAP_MS);
      }
    }

    onProgress?.({ phase: 'encoding' });
    const blob = await canvas.convertToBlob({
      type: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      quality: format === 'jpeg' ? 1.0 : undefined,
    });
    const dataUrl = await blobToDataUrl(blob);

    return { dataUrl, width: pxWidth, height: pxHeight };
  } finally {
    await restorePage(tab.id);
  }
}

async function restorePage(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: restoreAfterStitch });
  } catch (_) { /* tab may have navigated away; non-fatal */ }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob.'));
    reader.readAsDataURL(blob);
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   In-page helpers (executed via chrome.scripting.executeScript)
   These run as plain functions in the page's isolated world — they must be
   self-contained and free of imports or outer-scope references.
   ───────────────────────────────────────────────────────────────────────── */

function triggerLazyLoadInPage() {
  return new Promise(resolve => {
    const startX = window.scrollX;
    const startY = window.scrollY;
    const totalHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    const step = Math.max(200, window.innerHeight);
    let y = 0;
    const id = setInterval(() => {
      window.scrollTo(0, y);
      y += step;
      if (y >= totalHeight) {
        clearInterval(id);
        // Wait one frame for any IntersectionObservers to fire.
        requestAnimationFrame(() => {
          window.scrollTo(startX, startY);
          setTimeout(resolve, 80);
        });
      }
    }, 30);
  });
}

function prepareForStitch() {
  const docEl = document.documentElement;
  const body = document.body;

  const original = {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    htmlOverflow: docEl.style.overflow,
    htmlScrollBehavior: docEl.style.scrollBehavior,
    bodyOverflow: body ? body.style.overflow : '',
  };

  const modifiedElements = [];
  const all = document.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      modifiedElements.push({
        el,
        prevVisibility: el.style.visibility,
      });
      el.style.visibility = 'hidden';
    }
  }

  docEl.style.scrollBehavior = 'auto';

  // Stash on window for the restore call.
  window.__ScreenScott_state__ = { original, modifiedElements };

  return {
    totalWidth: Math.max(
      docEl.scrollWidth,
      body ? body.scrollWidth : 0,
      window.innerWidth,
    ),
    totalHeight: Math.max(
      docEl.scrollHeight,
      body ? body.scrollHeight : 0,
      window.innerHeight,
    ),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  };
}

function restoreAfterStitch() {
  const state = window.__ScreenScott_state__;
  if (!state) return;

  const { original, modifiedElements } = state;
  for (const item of modifiedElements) {
    item.el.style.visibility = item.prevVisibility;
  }
  document.documentElement.style.scrollBehavior = original.htmlScrollBehavior;
  document.documentElement.style.overflow = original.htmlOverflow;
  if (document.body) document.body.style.overflow = original.bodyOverflow;
  window.scrollTo(original.scrollX, original.scrollY);

  delete window.__ScreenScott_state__;
}
