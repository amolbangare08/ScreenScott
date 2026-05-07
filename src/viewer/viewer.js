/**
 * ScreenScot viewer — premium image preview with zoom, pan, copy, download.
 *
 * Loads the capture from chrome.storage.local (set by the service worker
 * before this tab was opened) and renders it with a smooth zoom/pan UX.
 */

const ZOOM_MIN  = 0.05;
const ZOOM_MAX  = 8;
const ZOOM_STEP = 0.15;

const els = {
  topbar:        document.querySelector('.topbar'),
  metaSource:    document.getElementById('meta-source'),
  metaDims:      document.getElementById('meta-dims'),
  metaFormat:    document.getElementById('meta-format'),
  metaSize:      document.getElementById('meta-size'),

  btnCopy:       document.getElementById('btn-copy'),
  btnDownload:   document.getElementById('btn-download'),

  stage:         document.getElementById('stage'),
  stageEmpty:    document.getElementById('stage-empty'),
  stageError:    document.getElementById('stage-error'),
  errorTitle:    document.getElementById('error-title'),
  errorMessage:  document.getElementById('error-message'),

  canvas:        document.getElementById('canvas'),
  image:         document.getElementById('image'),

  controls:      document.getElementById('controls'),
  zoomIn:        document.getElementById('zoom-in'),
  zoomOut:       document.getElementById('zoom-out'),
  zoomFit:       document.getElementById('zoom-fit'),
  zoom100:       document.getElementById('zoom-100'),
  zoomReadout:   document.getElementById('zoom-readout'),

  toast:         document.getElementById('toast'),
};

let state = {
  dataUrl: null,
  meta: null,
  naturalWidth: 0,
  naturalHeight: 0,
  zoom: 1,
  fitZoom: 1,
};

/* ─────────────────────────────────────────────────────────────────────────
   Bootstrapping
   ───────────────────────────────────────────────────────────────────────── */

(async function init() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    showError('Missing capture ID', 'Open a screenshot through the ScreenScot popup or shortcut.');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({ type: 'getCapture', id });
    if (!response?.ok || !response.dataUrl) {
      showError(
        "Couldn't load capture",
        response?.error || 'The capture may have expired. Try taking another screenshot.',
      );
      return;
    }

    state.dataUrl = response.dataUrl;
    state.meta = response.meta || {};

    await renderImage(state.dataUrl);
    populateMeta(state.meta, state.dataUrl);
    updateDocumentTitle(state.meta);
    bindEvents();

    // Tell the service worker we have it, so it can drop the storage entry.
    chrome.runtime.sendMessage({ type: 'consumeCapture', id }).catch(() => {});
  } catch (err) {
    console.error('[ScreenScot] viewer init failed:', err);
    showError('Something went wrong', err?.message || 'Unable to load this capture.');
  }
})();

/* ─────────────────────────────────────────────────────────────────────────
   Rendering
   ───────────────────────────────────────────────────────────────────────── */

function renderImage(dataUrl) {
  return new Promise((resolve, reject) => {
    els.image.onload = () => {
      state.naturalWidth = els.image.naturalWidth;
      state.naturalHeight = els.image.naturalHeight;

      els.stageEmpty.hidden = true;
      els.canvas.hidden = false;
      els.controls.hidden = false;

      // Initial zoom: fit to width, capped at 100%.
      requestAnimationFrame(() => {
        fitToScreen();
        resolve();
      });
    };
    els.image.onerror = () => reject(new Error('Image failed to decode.'));
    els.image.src = dataUrl;
  });
}

function populateMeta(meta, dataUrl) {
  const source = formatHostname(meta.url);
  if (source) els.metaSource.textContent = source;

  const w = meta.width || state.naturalWidth;
  const h = meta.height || state.naturalHeight;
  if (w && h) els.metaDims.textContent = `${w.toLocaleString()} × ${h.toLocaleString()}`;

  if (meta.format) els.metaFormat.textContent = meta.format.toUpperCase();
  els.metaSize.textContent = formatBytes(meta.bytes ?? estimateBytes(dataUrl));
}

function updateDocumentTitle(meta) {
  const host = formatHostname(meta.url) || 'capture';
  document.title = `ScreenScot — ${host}`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Zoom & pan
   ───────────────────────────────────────────────────────────────────────── */

function applyZoom() {
  els.image.style.transform = `scale(${state.zoom})`;
  els.image.style.width = state.naturalWidth + 'px';
  els.image.style.height = state.naturalHeight + 'px';
  els.zoomReadout.textContent = `${Math.round(state.zoom * 100)}%`;

  // Keep the canvas large enough to scroll the scaled image.
  els.canvas.style.minWidth  = (state.naturalWidth  * state.zoom + 48) + 'px';
  els.canvas.style.minHeight = (state.naturalHeight * state.zoom + 96) + 'px';

  els.image.classList.toggle('is-grabbable', state.zoom > state.fitZoom);
}

function setZoom(z, anchor) {
  const next = clamp(z, ZOOM_MIN, ZOOM_MAX);
  if (next === state.zoom) return;

  if (anchor) {
    // Keep the cursor anchor stable across the zoom step.
    const stage = els.stage;
    const before = anchor;
    const ratio = next / state.zoom;
    const stageRect = stage.getBoundingClientRect();
    const cursorX = before.clientX - stageRect.left + stage.scrollLeft;
    const cursorY = before.clientY - stageRect.top  + stage.scrollTop;

    state.zoom = next;
    applyZoom();

    stage.scrollLeft = cursorX * ratio - (before.clientX - stageRect.left);
    stage.scrollTop  = cursorY * ratio - (before.clientY - stageRect.top);
  } else {
    state.zoom = next;
    applyZoom();
  }
}

function fitToScreen() {
  const padX = 48;
  const padY = 96 + (els.topbar?.offsetHeight ?? 0);
  const stageW = els.stage.clientWidth - padX;
  const stageH = els.stage.clientHeight - padY;
  if (stageW <= 0 || stageH <= 0) return;

  const fit = Math.min(
    stageW / state.naturalWidth,
    stageH / state.naturalHeight,
    1, // never upscale on fit
  );
  state.fitZoom = Math.max(fit, ZOOM_MIN);
  state.zoom = state.fitZoom;
  applyZoom();

  // Center the image horizontally.
  els.stage.scrollLeft = (els.canvas.scrollWidth - els.stage.clientWidth) / 2;
  els.stage.scrollTop = 0;
}

function actualSize() {
  setZoom(1);
  // Center horizontally at 100%.
  requestAnimationFrame(() => {
    els.stage.scrollLeft = (els.canvas.scrollWidth - els.stage.clientWidth) / 2;
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Events
   ───────────────────────────────────────────────────────────────────────── */

function bindEvents() {
  els.btnDownload.addEventListener('click', downloadCapture);
  els.btnCopy.addEventListener('click', copyCapture);

  els.zoomIn.addEventListener('click',  () => setZoom(state.zoom + ZOOM_STEP));
  els.zoomOut.addEventListener('click', () => setZoom(state.zoom - ZOOM_STEP));
  els.zoomFit.addEventListener('click', fitToScreen);
  els.zoom100.addEventListener('click', actualSize);

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case 'd': case 'D': e.preventDefault(); downloadCapture(); break;
      case 'c': case 'C': e.preventDefault(); copyCapture();     break;
      case 'f': case 'F': e.preventDefault(); fitToScreen();     break;
      case '0':           e.preventDefault(); actualSize();      break;
      case '+': case '=': e.preventDefault(); setZoom(state.zoom + ZOOM_STEP); break;
      case '-': case '_': e.preventDefault(); setZoom(state.zoom - ZOOM_STEP); break;
    }
  });

  // Wheel zoom (Ctrl/Cmd + wheel).
  els.stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const direction = e.deltaY < 0 ? 1 : -1;
    const factor = 1 + direction * 0.12;
    setZoom(state.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
  }, { passive: false });

  // Drag to pan.
  let dragging = null;
  els.image.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (state.zoom <= state.fitZoom) return;
    dragging = {
      startX: e.clientX,
      startY: e.clientY,
      scrollX: els.stage.scrollLeft,
      scrollY: els.stage.scrollTop,
    };
    els.image.classList.add('is-grabbing');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    els.stage.scrollLeft = dragging.scrollX - (e.clientX - dragging.startX);
    els.stage.scrollTop  = dragging.scrollY - (e.clientY - dragging.startY);
  });

  ['mouseup', 'mouseleave', 'blur'].forEach(evt => {
    document.addEventListener(evt, () => {
      if (!dragging) return;
      dragging = null;
      els.image.classList.remove('is-grabbing');
    });
  });

  // Re-fit on resize (debounced).
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Only re-fit if user is still at fit zoom.
      if (Math.abs(state.zoom - state.fitZoom) < 0.001) fitToScreen();
    }, 120);
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   Actions
   ───────────────────────────────────────────────────────────────────────── */

async function downloadCapture() {
  if (!state.dataUrl) return;
  els.btnDownload.disabled = true;
  try {
    const filename = state.meta?.fileName || `ScreenScot_${Date.now()}.png`;
    await chrome.downloads.download({
      url: state.dataUrl,
      filename,
      saveAs: false,
    });
    showToast('Saved to Downloads', 'success');
  } catch (err) {
    console.error(err);
    showToast('Download failed', 'error');
  } finally {
    els.btnDownload.disabled = false;
  }
}

async function copyCapture() {
  if (!state.dataUrl) return;
  els.btnCopy.disabled = true;
  try {
    const blob = await (await fetch(state.dataUrl)).blob();

    if (blob.type === 'image/png') {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ]);
    } else {
      // Convert JPEG → PNG so the OS clipboard accepts it everywhere.
      const png = await jpegToPngBlob(blob);
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': png }),
      ]);
    }
    showToast('Copied to clipboard', 'success');
  } catch (err) {
    console.error(err);
    showToast(err?.message?.includes('focus') ? 'Click the page first, then copy' : 'Copy failed', 'error');
  } finally {
    els.btnCopy.disabled = false;
  }
}

async function jpegToPngBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.convertToBlob({ type: 'image/png' });
}

/* ─────────────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────────────── */

function showError(title, message) {
  els.stageEmpty.hidden = true;
  els.stageError.hidden = false;
  els.errorTitle.textContent = title;
  els.errorMessage.textContent = message;
  els.btnDownload.disabled = true;
  els.btnCopy.disabled = true;
}

let toastTimer;
function showToast(message, tone = 'info') {
  els.toast.hidden = false;
  els.toast.dataset.tone = tone;
  els.toast.textContent = message;
  void els.toast.offsetWidth;
  els.toast.classList.add('is-visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, 2200);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

function formatHostname(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function formatBytes(bytes) {
  if (!bytes || !Number.isFinite(bytes)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function estimateBytes(dataUrl) {
  if (!dataUrl) return 0;
  const idx = dataUrl.indexOf('base64,');
  if (idx === -1) return dataUrl.length;
  const b64 = dataUrl.slice(idx + 7);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
