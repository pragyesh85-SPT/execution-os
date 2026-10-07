// Shared helpers for the extension pages and the service worker.
const DEFAULT_HUB = 'http://localhost:4747';

async function getHub() {
  const { hub, pin } = await chrome.storage.local.get(['hub', 'pin']);
  return { hub: (hub || DEFAULT_HUB).replace(/\/$/, ''), pin: pin || '' };
}

async function hubFetch(path, init = {}) {
  const { hub, pin } = await getHub();
  const headers = { 'Content-Type': 'application/json', ...(pin ? { 'X-EOS-PIN': pin } : {}) };
  const res = await fetch(hub + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  if (!res.ok) throw new Error('Hub returned ' + res.status);
  return res.json();
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
