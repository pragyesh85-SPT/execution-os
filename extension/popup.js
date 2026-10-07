function line(cls, label, detail) {
  const el = document.getElementById('state');
  el.textContent = '';
  const b = document.createElement('span');
  b.className = cls;
  b.textContent = label;
  el.appendChild(b);
  if (detail) {
    el.appendChild(document.createElement('br'));
    const s = document.createElement('small');
    s.textContent = detail;
    el.appendChild(s);
  }
}

async function render() {
  const { hub, pin } = await getHub();
  document.getElementById('hub').value = hub;
  document.getElementById('pin').value = pin;
  const { last } = await chrome.storage.local.get('last');
  if (!last) return line('off', 'Not checked yet.');
  if (!last.ok) return line('err', 'Hub not reachable', 'Start Execution OS on this PC. Nothing is blocked meanwhile.');
  const s = last.state;
  const paused = s.pausedUntil && s.pausedUntil > Date.now();
  if (s.active && !paused) {
    line('on', 'Focus ON — ' + (s.block ? s.block.title : ''), 'until ' + (s.until ? fmtTime(s.until) : '—') + ' · ' + s.blocked.length + ' sites blocked');
  } else {
    line('off', (paused ? 'Paused' : 'Focus off') + ' — ' + (s.block ? s.block.title : 'no block'));
  }
}

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ hub: document.getElementById('hub').value.trim() || DEFAULT_HUB, pin: document.getElementById('pin').value.trim() });
  await chrome.runtime.sendMessage({ type: 'refresh' });
  render();
});

render();
