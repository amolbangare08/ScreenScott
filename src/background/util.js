/**
 * Shared helpers for background scripts.
 */

const RESTRICTED_PROTOCOLS = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|devtools|chrome-devtools|chrome-search|chrome-error|file):/i;
const RESTRICTED_HOSTS = [
  'chromewebstore.google.com',
  'chrome.google.com/webstore',
  'addons.mozilla.org',
  'microsoftedge.microsoft.com/addons'
];

export function isRestrictedUrl(url) {
  if (!url) return true;
  if (RESTRICTED_PROTOCOLS.test(url)) return true;
  return RESTRICTED_HOSTS.some(h => url.includes(h));
}

export function safeFilenameStem(urlString) {
  try {
    const u = new URL(urlString);
    const host = u.hostname.replace(/^www\./, '') || 'page';
    return host.replace(/[^a-z0-9.-]+/gi, '_');
  } catch {
    return 'page';
  }
}

export function timestampStem(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function buildFileName(url, format, when = new Date()) {
  return `ScreenScott_${safeFilenameStem(url)}_${timestampStem(when)}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Best-effort byte length of a base64 data URL payload.
 */
export function approxByteLength(dataUrl) {
  if (!dataUrl) return 0;
  const idx = dataUrl.indexOf('base64,');
  if (idx === -1) return dataUrl.length;
  const b64 = dataUrl.slice(idx + 7);
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
