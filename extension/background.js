// Focus Guard service worker.
// Every 30 s it asks the Execution OS hub "is a focus block running?" and turns
// redirect rules for the blocked domains on or off. If the hub cannot be reached,
// nothing is blocked (fail open) — the browser should never break because a PC is off.
importScripts('shared.js');

const RULE_BASE = 1000;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clearRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id) });
}

async function refresh() {
  let state = null;
  try {
    state = await hubFetch('/api/focus');
  } catch (e) {
    await chrome.storage.local.set({ last: { ok: false, error: String((e && e.message) || e), at: Date.now() } });
    await clearRules();
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.storage.local.set({ last: { ok: true, state, at: Date.now() } });
  const active = state.active && !(state.pausedUntil && state.pausedUntil > Date.now());
  await clearRules();
  if (!active) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const allowed = new Set((state.allowed || []).map((d) => d.toLowerCase()));
  const domains = (state.blocked || []).map((d) => d.toLowerCase()).filter((d) => d && !allowed.has(d));
  const page = chrome.runtime.getURL('blocked.html');
  const rules = domains.map((d, i) => ({
    id: RULE_BASE + i,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: page + '#\\1' } },
    condition: {
      regexFilter: '^(https?://(?:[^/]*\\.)?' + escapeRegex(d) + '(?:[:/?#].*)?)$',
      resourceTypes: ['main_frame'],
    },
  }));
  if (rules.length) await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  chrome.action.setBadgeBackgroundColor({ color: '#D9480F' });
  chrome.action.setBadgeText({ text: 'ON' });
}

function schedule() {
  chrome.alarms.create('eos-refresh', { periodInMinutes: 0.5 });
  refresh();
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener((a) => a.name === 'eos-refresh' && refresh());
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'refresh') refresh().then(() => reply({ ok: true }));
  return true;
});
