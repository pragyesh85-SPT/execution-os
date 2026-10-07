const target = decodeURIComponent(location.hash.slice(1) || '');
let host = '';
try {
  host = new URL(target).hostname.replace(/^www\./, '');
} catch {
  host = target;
}
document.getElementById('site').textContent = target;

(async () => {
  const { last } = await chrome.storage.local.get('last');
  const s = last && last.state;
  if (s && s.block) {
    document.getElementById('block').textContent = s.block.title + (s.until ? ' · until ' + fmtTime(s.until) : '');
    document.getElementById('title').textContent = host + ' is blocked during this focus block.';
  }
  if (s && s.mission) {
    document.getElementById('missionBox').hidden = false;
    document.getElementById('mission').textContent = s.mission;
  }
  // Count the resisted urge (0 minutes lost) — it shows up in the day's stats.
  hubFetch('/api/distraction', { method: 'POST', body: JSON.stringify({ minutes: 0, source: host, kind: 'urge_resisted' }) }).catch(() => {});
})();

document.getElementById('back').addEventListener('click', () => {
  if (history.length > 2) history.go(-2);
  else window.close();
});

document.getElementById('later').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    await hubFetch('/api/later', { method: 'POST', body: JSON.stringify({ url: target, title: host + ' — saved during focus' }) });
    msg.textContent = 'Saved to your Later list in Execution OS. Close this tab and get back to the mission.';
  } catch {
    msg.textContent = 'Could not reach Execution OS. Is the app (or hub) running?';
  }
});
