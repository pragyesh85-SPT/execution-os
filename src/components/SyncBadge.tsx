import { useStore } from '../state/store';
import { useNow } from '../state/runtime';

const COLOR = {
  local: 'var(--ink-3)',
  connecting: 'var(--warn)',
  online: 'var(--ok)',
  offline: 'var(--ink-3)',
  pin: 'var(--warn)',
} as const;

export function SyncBadge() {
  const sync = useStore((s) => s.sync);
  const conflicts = useStore((s) => s.conflicts.length);
  const setTab = useStore((s) => s.setTab);
  const open = useStore((s) => s.open);
  const now = useNow();
  const ago = sync.lastAt ? Math.max(0, Math.round((now - sync.lastAt) / 1000)) : null;

  let text: string;
  if (conflicts) text = `${conflicts} to decide`;
  else if (sync.status === 'online') text = sync.pending ? `Uploading ${sync.pending}…` : 'Synced with PC';
  else if (sync.status === 'offline') text = sync.pending ? `PC offline · ${sync.pending} saved here` : 'PC offline · working locally';
  else if (sync.status === 'pin') text = 'PIN needed';
  else if (sync.status === 'connecting') text = 'Connecting…';
  else text = sync.pending ? `This device only · ${sync.pending} unsynced` : 'This device only';

  return (
    <button
      className="chip"
      style={{ border: 0, cursor: 'pointer', height: 30 }}
      onClick={() => {
        if (conflicts) return open({ conflicts: true });
        try {
          localStorage.setItem('eos.settings.section', 'devices');
        } catch {
          /* ignore */
        }
        setTab('settings');
      }}
      title={sync.error ?? (ago !== null ? `Last sync ${ago}s ago` : 'Not connected to the PC hub')}
    >
      <span className="sync-dot" style={{ background: conflicts ? 'var(--warn)' : COLOR[sync.status] }} />
      {text}
      {sync.status === 'online' && !conflicts && ago !== null && ago > 10 && <span className="faint mono">{ago}s</span>}
    </button>
  );
}
