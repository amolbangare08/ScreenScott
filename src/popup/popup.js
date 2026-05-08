/**
 * ScreenScott popup controller.
 *
 * - Tracks the user's preferred output format in chrome.storage.sync.
 * - Sends capture requests to the service worker.
 * - Reflects progress / error states inline; the success path closes the popup
 *   automatically when Chrome focuses the new viewer tab.
 */

const PROGRESS_CHANNEL = 'ScreenScott-progress';
const FORMAT_KEY = 'ScreenScott_format';

const els = {
  status:        document.getElementById('status'),
  statusText:    document.getElementById('status-text'),
  progress:      document.getElementById('progress'),
  toast:         document.getElementById('toast'),
  formatHint:    document.getElementById('format-hint'),
  formatGroup:   document.querySelector('.seg'),
  formatOptions: document.querySelectorAll('.seg-option'),
  captureButtons: document.querySelectorAll('.capture-btn'),
};

const PHASE_TEXT = {
  attaching:  'Connecting to page…',
  measuring:  'Measuring page…',
  resizing:   'Preparing surface…',
  capturing:  'Capturing screenshot…',
  preparing:  'Preparing page…',
  stitching:  'Stitching slices…',
  fallback:   'Switching to fallback engine…',
  encoding:   'Encoding image…',
  opening:    'Opening viewer…',
};

let busy = false;

/* ─────────────────────────────────────────────────────────────────────────
   Init
   ───────────────────────────────────────────────────────────────────────── */

(async function init() {
  await loadFormat();
  bindEvents();
  listenToProgress();
})();

/* ─────────────────────────────────────────────────────────────────────────
   Format preference
   ───────────────────────────────────────────────────────────────────────── */

async function loadFormat() {
  const { [FORMAT_KEY]: stored } = await chrome.storage.sync.get(FORMAT_KEY);
  const format = (stored === 'jpeg' || stored === 'png') ? stored : 'png';
  setFormat(format, { persist: false });
}

async function setFormat(format, { persist = true } = {}) {
  els.formatGroup.dataset.active = format;
  els.formatOptions.forEach(opt => {
    const active = opt.dataset.format === format;
    opt.classList.toggle('is-active', active);
    opt.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  els.formatHint.textContent = format === 'png'
    ? 'Lossless. Best for text and UI.'
    : 'Smaller files. Best for photos.';
  if (persist) await chrome.storage.sync.set({ [FORMAT_KEY]: format });
}

function getFormat() {
  return els.formatGroup.dataset.active === 'jpeg' ? 'jpeg' : 'png';
}

/* ─────────────────────────────────────────────────────────────────────────
   Events
   ───────────────────────────────────────────────────────────────────────── */

function bindEvents() {
  els.formatOptions.forEach(opt => {
    opt.addEventListener('click', () => setFormat(opt.dataset.format));
  });

  els.captureButtons.forEach(btn => {
    btn.addEventListener('click', () => onCaptureClick(btn));
  });

  // Keyboard: Enter on focused button is native; add `1` and `2` as quick keys.
  document.addEventListener('keydown', (e) => {
    if (busy) return;
    if (e.key === '1') document.querySelector('[data-action="full"]')?.click();
    if (e.key === '2') document.querySelector('[data-action="visible"]')?.click();
    if (e.key === '3') document.querySelector('[data-action="batch"]')?.click();
  });
}

async function onCaptureClick(btn) {
  if (busy) return;
  const action = btn.dataset.action; // 'full' | 'visible' | 'batch'

  if (action === 'batch') {
    setBusy(true, 'Opening tab picker…');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'openPicker' });
      if (!response?.ok) throw new Error(response?.error || 'Could not open the picker.');
      // Popup closes automatically as the new tab takes focus.
    } catch (err) {
      setBusy(false);
      setStatus('error', truncate(err.message || 'Could not open the picker.', 80));
      showToast(err.message || 'Could not open the picker.', 'error');
    }
    return;
  }

  const format = getFormat();
  setBusy(true, action === 'full' ? 'Starting full-page capture…' : 'Capturing visible area…');

  try {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab to capture.');

    const response = await chrome.runtime.sendMessage({
      type: 'capture',
      mode: action === 'full' ? 'full' : 'visible',
      format,
      tabId: tab.id,
    });

    if (!response?.ok) throw new Error(response?.error || 'Capture failed.');
    setStatus('done', 'Captured. Opening viewer…');
  } catch (err) {
    setBusy(false);
    setStatus('error', truncate(err.message || 'Something went wrong.', 80));
    showToast(err.message || 'Capture failed.', 'error');
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Service-worker progress
   ───────────────────────────────────────────────────────────────────────── */

function listenToProgress() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== PROGRESS_CHANNEL) return;
    const phase = msg.payload?.phase;
    if (!phase) return;

    let text = PHASE_TEXT[phase] || 'Working…';
    if (phase === 'stitching' && msg.payload?.total) {
      text = `Stitching slice ${msg.payload.current} of ${msg.payload.total}…`;
    }
    setStatus('busy', text);
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   UI helpers
   ───────────────────────────────────────────────────────────────────────── */

function setBusy(value, text) {
  busy = value;
  els.captureButtons.forEach(btn => { btn.disabled = value; });
  if (value) {
    setStatus('busy', text || 'Working…');
  }
}

function setStatus(state, text) {
  els.status.dataset.state = state;
  els.statusText.textContent = text;
  els.progress.hidden = state !== 'busy';
}

let toastTimer;
function showToast(message, tone = 'info') {
  els.toast.hidden = false;
  els.toast.dataset.tone = tone;
  els.toast.textContent = message;
  // Force reflow so the transition runs.
  void els.toast.offsetWidth;
  els.toast.classList.add('is-visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    setTimeout(() => { els.toast.hidden = true; }, 220);
  }, 3500);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
