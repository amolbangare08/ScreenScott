/**
 * ScreenScott batch-capture picker.
 *
 * Loads the user's open tabs, lets them choose which to capture, what mode
 * (Full Page / Visible Area), and what format. Streams progress from the
 * service worker into a per-tab status list and shows a final report.
 */

const PROGRESS_CHANNEL = 'ScreenScott-batch-progress';
const FORMAT_KEY = 'ScreenScott_format';

const els = {
  search:        document.getElementById('search'),
  selectAll:     document.getElementById('select-all'),
  selectNone:    document.getElementById('select-none'),
  invert:        document.getElementById('invert'),
  list:          document.getElementById('tab-list'),
  loading:       document.getElementById('loading'),

  modeRadios:    document.querySelectorAll('input[name="mode"]'),

  segGroup:      document.querySelector('.seg'),
  segOptions:    document.querySelectorAll('.seg-option'),
  formatHint:    document.getElementById('format-hint'),

  summary:       document.getElementById('summary'),
  summaryCount:  document.getElementById('summary-count'),

  run:           document.getElementById('run'),

  overlay:       document.getElementById('overlay'),
  overlayTitle:  document.getElementById('overlay-title'),
  overlaySub:    document.getElementById('overlay-sub'),
  overlayCounter:document.getElementById('overlay-counter'),
  progressFill:  document.getElementById('progress-fill'),
  progressList:  document.getElementById('progress-list'),
  overlayCancel: document.getElementById('overlay-cancel'),
  overlayClose:  document.getElementById('overlay-close'),

  toast:         document.getElementById('toast'),
};

const state = {
  tabs: [],                      // all tabs (excluding picker itself)
  selectedIds: new Set(),
  windowOrder: [],               // window IDs in display order
  currentWindowId: null,
  filter: '',
  format: 'png',
  inProgress: false,
  progressMap: new Map(),        // tabId -> {state, name?, error?}
};

/* ─────────── Init ─────────── */

(async function init() {
  await loadFormat();
  bindEvents();
  listenToProgress();
  await refreshTabs();
})();

/* ─────────── Tabs ─────────── */

async function refreshTabs() {
  els.loading.style.display = '';
  const response = await chrome.runtime.sendMessage({ type: 'listTabs' });
  if (!response?.ok) {
    showToast(response?.error || 'Could not load tabs.', 'error');
    return;
  }
  state.tabs = response.tabs;
  state.currentWindowId = response.currentWindowId;
  state.windowOrder = computeWindowOrder(state.tabs, state.currentWindowId);

  // Pre-select all eligible (non-restricted) tabs in the user's current window.
  state.selectedIds = new Set(
    state.tabs
      .filter(t => t.windowId === state.currentWindowId && !t.restricted)
      .map(t => t.id)
  );

  renderList();
  updateSummary();
}

function computeWindowOrder(tabs, currentId) {
  const seen = new Set();
  const order = [];
  if (currentId != null) {
    order.push(currentId);
    seen.add(currentId);
  }
  for (const t of tabs) {
    if (!seen.has(t.windowId)) {
      seen.add(t.windowId);
      order.push(t.windowId);
    }
  }
  return order;
}

function renderList() {
  const filter = state.filter.toLowerCase();
  const matches = (t) =>
    !filter ||
    (t.title || '').toLowerCase().includes(filter) ||
    (t.url || '').toLowerCase().includes(filter);

  const fragment = document.createDocumentFragment();
  let totalShown = 0;

  for (let wIdx = 0; wIdx < state.windowOrder.length; wIdx++) {
    const wId = state.windowOrder[wIdx];
    const tabsInWindow = state.tabs
      .filter(t => t.windowId === wId && matches(t))
      .sort((a, b) => a.index - b.index);

    if (tabsInWindow.length === 0) continue;
    totalShown += tabsInWindow.length;

    const group = document.createElement('section');
    group.className = 'window-group';
    group.dataset.windowId = String(wId);

    const header = document.createElement('header');
    header.className = 'window-header';

    const title = document.createElement('span');
    title.textContent = wId === state.currentWindowId
      ? `Current window · ${tabsInWindow.length} tabs`
      : `Window ${wIdx + 1} · ${tabsInWindow.length} tabs`;

    const action = document.createElement('button');
    action.className = 'link-btn';
    action.textContent = allWindowSelected(tabsInWindow) ? 'Deselect window' : 'Select window';
    action.type = 'button';
    action.addEventListener('click', () => toggleWindow(tabsInWindow));

    header.append(title, action);
    group.append(header);

    for (const tab of tabsInWindow) group.append(renderTabRow(tab));
    fragment.append(group);
  }

  els.list.replaceChildren();
  els.loading.remove();

  if (totalShown === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const txt = document.createElement('p');
    txt.textContent = state.filter ? 'No tabs match your search.' : 'No open tabs found.';
    empty.append(txt);
    els.list.append(empty);
  } else {
    els.list.append(fragment);
  }

  els.list.setAttribute('aria-busy', 'false');
}

function renderTabRow(tab) {
  const row = document.createElement('div');
  row.className = 'tab-row';
  row.dataset.tabId = String(tab.id);
  row.role = 'listitem';
  if (tab.restricted) row.classList.add('is-restricted');
  if (state.selectedIds.has(tab.id)) row.classList.add('is-selected');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tab-checkbox';
  checkbox.checked = state.selectedIds.has(tab.id);
  checkbox.disabled = tab.restricted;
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    toggleSelected(tab.id, checkbox.checked);
  });

  const favWrap = document.createElement('div');
  favWrap.className = 'tab-favicon';
  if (tab.favIconUrl) {
    const img = document.createElement('img');
    img.src = tab.favIconUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => { favWrap.replaceChildren(makeFaviconFallback(tab)); });
    favWrap.append(img);
  } else {
    favWrap.append(makeFaviconFallback(tab));
  }

  const info = document.createElement('div');
  info.className = 'tab-info';
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = cleanTabTitle(tab.title) || '(untitled tab)';
  const url = document.createElement('span');
  url.className = 'tab-url';
  url.textContent = formatUrl(tab.url);
  info.append(title, url);

  row.append(checkbox, favWrap, info);

  // Clicking the row (not the checkbox) toggles selection.
  row.addEventListener('click', (e) => {
    if (tab.restricted) return;
    if (e.target === checkbox) return;
    const next = !state.selectedIds.has(tab.id);
    checkbox.checked = next;
    toggleSelected(tab.id, next);
  });

  return row;
}

function makeFaviconFallback(tab) {
  const span = document.createElement('span');
  span.textContent = (tab.title?.[0] || tab.url?.[8] || '·').toUpperCase();
  return span;
}

function toggleSelected(tabId, value) {
  if (value) state.selectedIds.add(tabId);
  else       state.selectedIds.delete(tabId);
  const row = els.list.querySelector(`.tab-row[data-tab-id="${tabId}"]`);
  if (row) row.classList.toggle('is-selected', value);
  updateSummary();
}

function toggleWindow(tabsInWindow) {
  const allSelected = allWindowSelected(tabsInWindow);
  for (const t of tabsInWindow) {
    if (t.restricted) continue;
    if (allSelected) state.selectedIds.delete(t.id);
    else             state.selectedIds.add(t.id);
  }
  renderList();
  updateSummary();
}

function allWindowSelected(tabsInWindow) {
  const selectable = tabsInWindow.filter(t => !t.restricted);
  if (selectable.length === 0) return false;
  return selectable.every(t => state.selectedIds.has(t.id));
}

function updateSummary() {
  const n = state.selectedIds.size;
  els.summaryCount.textContent =
    n === 0 ? '0 tabs selected'
            : n === 1 ? '1 tab selected'
                      : `${n} tabs selected`;
  els.run.disabled = n === 0 || state.inProgress;
}

/* ─────────── Format & mode ─────────── */

async function loadFormat() {
  const { [FORMAT_KEY]: stored } = await chrome.storage.sync.get(FORMAT_KEY);
  setFormat(stored === 'jpeg' ? 'jpeg' : 'png', { persist: false });
}

function setFormat(format, { persist = true } = {}) {
  state.format = format;
  els.segGroup.dataset.active = format;
  els.segOptions.forEach(opt => {
    const active = opt.dataset.format === format;
    opt.classList.toggle('is-active', active);
    opt.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  els.formatHint.textContent = format === 'png'
    ? 'Lossless. Best for text and UI.'
    : 'Smaller files. Best for photos.';
  if (persist) chrome.storage.sync.set({ [FORMAT_KEY]: format }).catch(() => {});
}

function getMode() {
  const checked = Array.from(els.modeRadios).find(r => r.checked);
  return checked?.value === 'visible' ? 'visible' : 'full';
}

/* ─────────── Events ─────────── */

function bindEvents() {
  els.search.addEventListener('input', () => {
    state.filter = els.search.value;
    renderList();
  });

  els.selectAll.addEventListener('click', () => {
    for (const t of state.tabs) if (!t.restricted) state.selectedIds.add(t.id);
    renderList(); updateSummary();
  });
  els.selectNone.addEventListener('click', () => {
    state.selectedIds.clear();
    renderList(); updateSummary();
  });
  els.invert.addEventListener('click', () => {
    for (const t of state.tabs) {
      if (t.restricted) continue;
      if (state.selectedIds.has(t.id)) state.selectedIds.delete(t.id);
      else state.selectedIds.add(t.id);
    }
    renderList(); updateSummary();
  });

  els.segOptions.forEach(opt => opt.addEventListener('click', () => setFormat(opt.dataset.format)));

  els.run.addEventListener('click', startBatch);
  els.overlayCancel.addEventListener('click', cancelBatch);
  els.overlayClose.addEventListener('click', closeOverlay);

  // React to tabs being closed/opened while picker is open.
  chrome.tabs.onRemoved.addListener(handleTabsChanged);
  chrome.tabs.onCreated.addListener(handleTabsChanged);
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.title || info.url || info.favIconUrl) handleTabsChanged();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.overlay.hidden && els.overlayClose.hidden) {
      // Don't close while batch is still in flight.
      return;
    }
    if (e.key === 'Escape' && !els.overlay.hidden) closeOverlay();
  });
}

let refreshTimer;
function handleTabsChanged() {
  if (state.inProgress) return; // don't disrupt during batch
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshTabs, 200);
}

/* ─────────── Run ─────────── */

function startBatch() {
  const tabIds = [...state.selectedIds];
  if (tabIds.length === 0) return;

  state.inProgress = true;
  els.run.disabled = true;
  prepareOverlay(tabIds);
  els.overlay.hidden = false;

  // Fire-and-forget: MV3 service workers can be terminated during long batches,
  // which silently drops the sendMessage response channel. Completion is signalled
  // via batch-result / batch-error progress messages instead.
  chrome.runtime.sendMessage({
    type: 'batchCapture',
    tabIds,
    mode: getMode(),
    format: state.format,
  }).catch((err) => {
    // Only fires if the service worker couldn't be reached at all.
    finalizeOverlay({ ok: false, error: err?.message || 'Could not reach the extension.', results: [] });
    state.inProgress = false;
    updateSummary();
  });
}

async function cancelBatch() {
  await chrome.runtime.sendMessage({ type: 'cancelBatch' }).catch(() => {});
  showToast('Cancelling…');
}

function closeOverlay() {
  els.overlay.hidden = true;
  els.overlayClose.hidden = true;
  els.overlayCancel.hidden = false;
  els.progressList.replaceChildren();
  state.progressMap.clear();
}

/* ─────────── Overlay rendering ─────────── */

function prepareOverlay(tabIds) {
  els.overlayTitle.textContent = 'Capturing tabs…';
  els.overlaySub.textContent = 'Please wait — this may take a moment.';
  els.overlayCounter.textContent = `0 / ${tabIds.length}`;
  els.progressFill.style.width = '0%';
  els.overlayClose.hidden = true;
  els.overlayCancel.hidden = false;

  els.progressList.replaceChildren();
  state.progressMap.clear();

  for (const id of tabIds) {
    const tab = state.tabs.find(t => t.id === id);
    const li = document.createElement('li');
    li.className = 'progress-item';
    li.dataset.tabId = String(id);
    li.dataset.state = 'pending';

    const status = document.createElement('span');
    status.className = 'pi-status';

    const title = document.createElement('span');
    title.className = 'pi-title';
    title.textContent = cleanTabTitle(tab?.title) || `Tab ${id}`;

    const meta = document.createElement('span');
    meta.className = 'pi-meta';
    meta.textContent = '';

    li.append(status, title, meta);
    els.progressList.append(li);
    state.progressMap.set(id, { state: 'pending' });
  }
}

function listenToProgress() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== PROGRESS_CHANNEL) return;
    const p = msg.payload || {};
    const total = p.total ?? state.progressMap.size;
    const current = p.current ?? 0;

    if (p.tabId != null) {
      const li = els.progressList.querySelector(`.progress-item[data-tab-id="${p.tabId}"]`);
      if (li) {
        if (p.phase === 'tab-start')  setItemState(li, 'active', '');
        if (p.phase === 'tab-done') {
          setItemState(li, 'success', '\u2713');
          state.progressMap.set(p.tabId, { state: 'success' });
        }
        if (p.phase === 'tab-failed') {
          setItemState(li, 'failed', p.error || 'failed');
          state.progressMap.set(p.tabId, { state: 'failed' });
        }
      }
      // Compute progress from local state — reliable even if messages arrive out of order.
      const done = [...state.progressMap.values()].filter(v => v.state === 'success' || v.state === 'failed').length;
      const tot  = state.progressMap.size;
      if (tot > 0) {
        els.overlayCounter.textContent = `${done} / ${tot}`;
        els.progressFill.style.width   = `${Math.round(done / tot * 100)}%`;
      }
    }

    if (p.phase === 'packaging') {
      els.overlayTitle.textContent = 'Packaging ZIP…';
      els.overlaySub.textContent = 'Building the archive.';
    }
    if (p.phase === 'cancelled') {
      els.overlayTitle.textContent = 'Cancelled';
      els.overlaySub.textContent = `Stopped after ${current} of ${total} tabs.`;
    }

    // Batch completion signals (fire-and-forget pattern).
    if (p.phase === 'batch-result') {
      const n = p.results?.length ?? state.progressMap.size;
      const ok = p.results?.filter(r => r.ok).length ?? n;
      // Ensure counter and bar reflect completion before finalizing.
      els.overlayCounter.textContent = `${n} / ${n}`;
      els.progressFill.style.width = '100%';
      finalizeOverlay({ ok: true, filename: p.filename, downloadId: p.downloadId, results: p.results || [] });
      state.inProgress = false;
      updateSummary();
    }
    if (p.phase === 'batch-error') {
      const n = state.progressMap.size;
      els.overlayCounter.textContent = `${n} / ${n}`;
      finalizeOverlay({ ok: false, error: p.error || 'Batch failed.', results: p.results || [] });
      state.inProgress = false;
      updateSummary();
    }
  });
}

function setItemState(li, st, metaText) {
  li.dataset.state = st;
  const meta = li.querySelector('.pi-meta');
  if (meta) meta.textContent = metaText || '';
  const status = li.querySelector('.pi-status');
  if (status) {
    status.replaceChildren();
    if (st === 'success') status.textContent = '✓';
    if (st === 'failed')  status.textContent = '!';
  }
}

function finalizeOverlay({ ok, error, results = [], filename, downloadId }) {
  const successCount = results.filter(r => r.ok).length;
  const failCount = results.filter(r => !r.ok).length;

  if (ok && filename) {
    els.overlayTitle.textContent = 'Done';
    els.overlaySub.textContent =
      failCount === 0
        ? `Captured ${successCount} tab${successCount === 1 ? '' : 's'} into ${filename}.`
        : `Captured ${successCount} of ${successCount + failCount} tabs into ${filename}.`;
    els.progressFill.style.width = '100%';
    showToast(`Saved ${filename} to Downloads`, 'success');
  } else {
    els.overlayTitle.textContent = failCount && successCount === 0 ? 'No tabs captured' : 'Stopped';
    els.overlaySub.textContent = error || 'Some tabs could not be captured.';
  }

  els.overlayCancel.hidden = true;
  els.overlayClose.hidden = false;
}

/* ─────────── Helpers ─────────── */

function formatUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    let path = u.pathname + (u.search ? u.search : '');
    if (path.length > 60) path = path.slice(0, 59) + '\u2026';
    return u.host + (path === '/' ? '' : path);
  } catch {
    return url;
  }
}

/**
 * Strip leading notification-count prefix like "(143) " that browsers
 * (e.g. YouTube) prepend to the page title when there are unread items.
 */
function cleanTabTitle(title) {
  return (title || '').replace(/^\(\d+\)\s*/, '');
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
  }, 2400);
}
