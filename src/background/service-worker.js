/**
 * ScreenScot — service worker entry.
 *
 * Responsibilities:
 *   - Routes messages from the popup and viewer.
 *   - Orchestrates capture (visible / full-page CDP / stitch fallback).
 *   - Hands off the captured image to the viewer page via chrome.storage.local.
 *   - Listens for keyboard commands.
 */

import {
  captureVisible,
  captureFullPageCDP,
  captureFullPageStitch,
} from './capture.js';
import {
  isRestrictedUrl,
  buildFileName,
  approxByteLength,
} from './util.js';
import { runBatch } from './batch.js';

const CAPTURE_KEY_PREFIX = 'capture_';
const CAPTURE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const PROGRESS_CHANNEL = 'ScreenScot-progress';
const PICKER_URL = 'src/picker/picker.html';

let inFlight = false;
let batchInFlight = false;
let batchCancelRequested = false;

/* ─────────────────────────────────────────────────────────────────────────
   Lifecycle
   ───────────────────────────────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(() => { cleanupOldCaptures(); });
chrome.runtime.onStartup.addListener?.(() => { cleanupOldCaptures(); });

/* ─────────────────────────────────────────────────────────────────────────
   Message routing
   ───────────────────────────────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'capture': {
      runCapture(msg)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true; // keep the channel open for async response
    }

    case 'getCapture': {
      readCapture(msg.id)
        .then(payload => sendResponse(payload))
        .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    case 'consumeCapture': {
      // Viewer signals that it has the data and we can drop it.
      chrome.storage.local.remove(CAPTURE_KEY_PREFIX + msg.id).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }

    case 'openPicker': {
      openPicker()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    case 'listTabs': {
      listTabsForPicker()
        .then(payload => sendResponse(payload))
        .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    case 'batchCapture': {
      runBatchOrchestrated(msg)
        .then(result => sendResponse(result))
        .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    case 'cancelBatch': {
      if (batchInFlight) batchCancelRequested = true;
      sendResponse({ ok: true });
      return false;
    }

    default:
      return;
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Keyboard commands
   ───────────────────────────────────────────────────────────────────────── */

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (command === 'capture-full-page') {
      await runCapture({ mode: 'full', format: 'png', tabId: tab.id });
    } else if (command === 'capture-visible') {
      await runCapture({ mode: 'visible', format: 'png', tabId: tab.id });
    }
  } catch (err) {
    console.error('[ScreenScot] command failed:', err);
  }
});

/* ─────────────────────────────────────────────────────────────────────────
   Capture orchestration
   ───────────────────────────────────────────────────────────────────────── */

async function runCapture({ mode, format = 'png', tabId }) {
  if (inFlight) {
    return { ok: false, error: 'A capture is already in progress.' };
  }
  if (!['png', 'jpeg'].includes(format)) format = 'png';
  if (!['visible', 'full'].includes(mode)) mode = 'full';

  inFlight = true;

  try {
    const tab = tabId
      ? await chrome.tabs.get(tabId)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

    if (!tab) throw new Error('No active tab to capture.');
    if (isRestrictedUrl(tab.url)) {
      throw new Error('This page is restricted by the browser and cannot be captured.');
    }

    const onProgress = (info) => broadcastProgress({ ...info, mode });

    let captureResult;
    let engineUsed;

    if (mode === 'visible') {
      onProgress({ phase: 'capturing' });
      const dataUrl = await captureVisible(tab, format);
      captureResult = { dataUrl };
      engineUsed = 'visible';
    } else {
      try {
        captureResult = await captureFullPageCDP(tab, format, { onProgress });
        engineUsed = 'cdp';
      } catch (cdpErr) {
        console.warn('[ScreenScot] CDP capture failed, falling back to stitch:', cdpErr);
        onProgress({ phase: 'fallback' });
        captureResult = await captureFullPageStitch(tab, format, { onProgress });
        engineUsed = 'stitch';
      }
    }

    const { dataUrl } = captureResult;
    const dimensions = await measureDataUrl(dataUrl, captureResult);
    const bytes = approxByteLength(dataUrl);
    const fileName = buildFileName(tab.url, format);

    const meta = {
      url: tab.url,
      title: tab.title || '',
      mode,
      format,
      engine: engineUsed,
      width: dimensions.width,
      height: dimensions.height,
      bytes,
      fileName,
      capturedAt: Date.now(),
    };

    const id = crypto.randomUUID();
    await chrome.storage.local.set({
      [CAPTURE_KEY_PREFIX + id]: { dataUrl, meta },
    });

    onProgress({ phase: 'opening' });

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`src/viewer/viewer.html?id=${id}`),
      active: true,
    });

    return { ok: true, id, meta };
  } finally {
    inFlight = false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Helpers
   ───────────────────────────────────────────────────────────────────────── */

function broadcastProgress(payload) {
  // Best-effort: popup may have closed already. Suppress "no receiving end" errors.
  chrome.runtime.sendMessage({ type: PROGRESS_CHANNEL, payload }).catch(() => {});
}

async function readCapture(id) {
  if (!id) return { ok: false, error: 'Missing capture id.' };
  const key = CAPTURE_KEY_PREFIX + id;
  const result = await chrome.storage.local.get(key);
  const entry = result[key];
  if (!entry) return { ok: false, error: 'Capture not found or expired.' };
  return { ok: true, ...entry };
}

async function cleanupOldCaptures() {
  try {
    const all = await chrome.storage.local.get(null);
    const cutoff = Date.now() - CAPTURE_TTL_MS;
    const expiredKeys = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(CAPTURE_KEY_PREFIX)) continue;
      if (!value?.meta?.capturedAt || value.meta.capturedAt < cutoff) {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length) await chrome.storage.local.remove(expiredKeys);
  } catch (err) {
    console.warn('[ScreenScot] cleanup failed:', err);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Picker / batch orchestration
   ───────────────────────────────────────────────────────────────────────── */

async function openPicker() {
  const url = chrome.runtime.getURL(PICKER_URL);
  // Reuse an existing picker tab if one is open.
  const existing = await chrome.tabs.query({ url });
  if (existing.length > 0) {
    const tab = existing[0];
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId != null) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
    }
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

async function listTabsForPicker() {
  const pickerUrl = chrome.runtime.getURL(PICKER_URL);
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent({ populate: false }).catch(() => null);

  const tabs = allTabs
    .filter(t => t.url !== pickerUrl) // don't include the picker itself
    .map(t => ({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      title: t.title || '',
      url: t.url || '',
      favIconUrl: t.favIconUrl || '',
      active: !!t.active,
      pinned: !!t.pinned,
      discarded: !!t.discarded,
      restricted: isRestrictedUrl(t.url),
    }));

  return {
    ok: true,
    tabs,
    currentWindowId: currentWindow?.id ?? null,
  };
}

async function runBatchOrchestrated({ tabIds, mode, format }) {
  if (batchInFlight) {
    broadcastBatchProgress({ phase: 'batch-error', error: 'A batch is already in progress.', results: [] });
    return { ok: false, error: 'A batch is already in progress.' };
  }
  if (inFlight) {
    broadcastBatchProgress({ phase: 'batch-error', error: 'A capture is already in progress.', results: [] });
    return { ok: false, error: 'A capture is already in progress.' };
  }

  batchInFlight = true;
  batchCancelRequested = false;

  try {
    const result = await runBatch({
      tabIds,
      mode,
      format,
      isCancelled: () => batchCancelRequested,
    });

    if (!result.ok || !result.blob) {
      broadcastBatchProgress({
        phase: 'batch-error',
        error: result.error || 'Batch was cancelled or produced no captures.',
        results: result.results,
      });
      return { ok: false, error: result.error || 'Batch was cancelled or produced no captures.', results: result.results };
    }

    try {
      const downloadId = await downloadBlob(result.blob, result.filename);
      broadcastBatchProgress({
        phase: 'batch-result',
        ok: true,
        filename: result.filename,
        downloadId,
        results: result.results,
      });
      return { ok: true, filename: result.filename, downloadId, results: result.results };
    } catch (dlErr) {
      const errMsg = dlErr?.message || 'Download failed after packaging.';
      broadcastBatchProgress({ phase: 'batch-error', error: errMsg, results: result.results });
      return { ok: false, error: errMsg, results: result.results };
    }
  } finally {
    batchInFlight = false;
    batchCancelRequested = false;
  }
}

function broadcastBatchProgress(payload) {
  chrome.runtime.sendMessage({ type: 'ScreenScot-batch-progress', payload }).catch(() => {});
}

async function downloadBlob(blob, filename) {
  // URL.createObjectURL is not available in MV3 service workers.
  // Convert the blob to a base64 data URL, which chrome.downloads accepts.
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(arrayBuffer);
  const dataUrl = `data:application/octet-stream;base64,${base64}`;
  const id = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return id;
}

/**
 * Converts an ArrayBuffer to a base64 string, processed in 32 KB chunks
 * to avoid call-stack overflow on large ZIP files.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000; // 32 768 bytes
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function measureDataUrl(dataUrl, fallback = {}) {
  if (fallback.width && fallback.height) {
    return { width: fallback.width, height: fallback.height };
  }
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  } catch {
    return { width: 0, height: 0 };
  }
}
