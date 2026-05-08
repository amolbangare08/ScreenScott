/**
 * Batch capture orchestrator.
 *
 * Iterates a list of tab IDs, activating each in turn and capturing it with
 * the requested engine. Streams per-tab progress events back via
 * chrome.runtime.sendMessage so the picker UI can render them live.
 *
 * Cancellable: a shared in-flight token can be flipped from outside (the
 * picker disconnect or an explicit cancel message) to abort between captures.
 */

import {
  captureVisible,
  captureFullPageCDP,
  captureFullPageStitch,
} from './capture.js';
import { isRestrictedUrl, safeFilenameStem, sleep } from './util.js';
import { ZipBuilder, sanitizeFilename, uniquifyFilename, dataUrlToBytes } from './zip.js';

const PROGRESS_CHANNEL = 'ScreenScott-batch-progress';

// Settle time after activating a tab — gives the renderer time to paint fully.
// Longer = better quality; shorter = faster batch. 1200ms is a safe default.
const TAB_ACTIVATE_SETTLE_MS = 1200;

// Gap between consecutive tab captures to stay under Chrome's
// captureVisibleTab rate limit (2 calls/sec across all calls).
const INTER_TAB_GAP_MS = 1000;

/**
 * Run the batch.
 *
 * @param {object} opts
 * @param {number[]} opts.tabIds      Tabs to capture, in order.
 * @param {'full'|'visible'} opts.mode
 * @param {'png'|'jpeg'} opts.format
 * @param {() => boolean} [opts.isCancelled]  Polled between captures.
 * @returns {Promise<{
 *   ok: boolean,
 *   blob?: Blob,
 *   filename?: string,
 *   results: Array<{tabId:number, ok:boolean, name?:string, error?:string}>,
 * }>}
 */
export async function runBatch({ tabIds, mode = 'full', format = 'png', isCancelled }) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) {
    throw new Error('No tabs selected.');
  }

  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const usedNames = new Set();
  const results = [];
  const zip = new ZipBuilder();

  const originalActiveTab = await getActiveTabSafely();

  try {
    for (let i = 0; i < tabIds.length; i++) {
      if (isCancelled?.()) {
        emit({ phase: 'cancelled', current: i, total: tabIds.length });
        return { ok: false, results, cancelled: true };
      }

      const tabId = tabIds[i];
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        results.push({ tabId, ok: false, error: 'Tab no longer exists.' });
        emit({ phase: 'tab-failed', tabId, current: i + 1, total: tabIds.length, error: 'Tab no longer exists.' });
        continue;
      }

      if (isRestrictedUrl(tab.url)) {
        results.push({ tabId, ok: false, name: tab.title, error: 'Restricted page.' });
        emit({ phase: 'tab-failed', tabId, current: i + 1, total: tabIds.length, error: 'Restricted page.' });
        continue;
      }

      emit({
        phase: 'tab-start',
        tabId,
        current: i + 1,
        total: tabIds.length,
        title: tab.title,
        url: tab.url,
      });

      try {
        await activateAndSettle(tab);

        const captureResult = await captureOne(tab, mode, format);
        const baseName = makeFileName(tab, ext);
        const finalName = uniquifyFilename(baseName, usedNames);

        const bytes = dataUrlToBytes(captureResult.dataUrl);
        await zip.addFile(finalName, bytes, new Date());

        results.push({ tabId, ok: true, name: finalName });
        emit({
          phase: 'tab-done',
          tabId,
          current: i + 1,
          total: tabIds.length,
          name: finalName,
        });

        // Inter-tab gap: prevents rate-limit errors when the next tab
        // also needs captureVisibleTab (stitch fallback).
        if (i < tabIds.length - 1) await sleep(INTER_TAB_GAP_MS);
      } catch (err) {
        const message = err?.message || String(err);
        results.push({ tabId, ok: false, name: tab.title, error: message });
        emit({
          phase: 'tab-failed',
          tabId,
          current: i + 1,
          total: tabIds.length,
          error: message,
        });
      }
    }

    const successes = results.filter(r => r.ok).length;
    if (successes === 0) {
      emit({ phase: 'done-empty', total: tabIds.length, results });
      return { ok: false, results, error: 'No tabs were captured.' };
    }

    emit({ phase: 'packaging', total: tabIds.length, results });
    const blob = zip.build();
    const filename = makeArchiveName();

    emit({ phase: 'done', total: tabIds.length, results, filename, size: blob.size });

    return { ok: true, blob, filename, results };
  } finally {
    if (originalActiveTab) {
      try { await chrome.tabs.update(originalActiveTab.id, { active: true }); }
      catch { /* tab may have closed */ }
    }
  }
}

/* ─────────── helpers ─────────── */

async function captureOne(tab, mode, format) {
  if (mode === 'visible') {
    const dataUrl = await captureVisible(tab, format);
    return { dataUrl };
  }
  // Full page: try CDP, fall back to stitch.
  try {
    return await captureFullPageCDP(tab, format);
  } catch (err) {
    console.warn('[ScreenScott] CDP failed for tab', tab.id, '→ stitch', err);
    return await captureFullPageStitch(tab, format);
  }
}

async function activateAndSettle(tab) {
  // Bring the tab to focus in its window. Required for captureVisibleTab and
  // also helps the renderer wake up if the tab was discarded.
  await chrome.tabs.update(tab.id, { active: true });
  // If the window is minimized/background, focus it too.
  try { await chrome.windows.update(tab.windowId, { focused: true }); }
  catch { /* non-fatal */ }

  // Wait for the tab to be in a usable state (not discarded, complete-ish).
  await waitForTabReady(tab.id);

  // Brief settle so any animation-on-focus has time to begin/end.
  await sleep(TAB_ACTIVATE_SETTLE_MS);
}

function waitForTabReady(tabId, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (!t.discarded && (t.status === 'complete' || Date.now() - start > timeoutMs)) {
          return resolve();
        }
      } catch {
        return resolve(); // tab gone; let caller handle it
      }
      setTimeout(tick, 120);
    };
    tick();
  });
}

async function getActiveTabSafely() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
  } catch {
    return null;
  }
}

function makeFileName(tab, ext) {
  const rawTitle = (tab.title || '').replace(/^\(\d+\)\s*/, ''); // strip e.g. "(143) "
  const titlePart = sanitizeFilename(rawTitle, 60);
  const hostPart  = safeFilenameStem(tab.url || '');
  return `${titlePart} — ${hostPart}.${ext}`;
}

function makeArchiveName(when = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
                `_${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
  return `ScreenScott_batch_${stamp}.zip`;
}

function emit(payload) {
  chrome.runtime.sendMessage({ type: PROGRESS_CHANNEL, payload }).catch(() => {});
}
