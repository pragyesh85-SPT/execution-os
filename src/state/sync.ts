import { normalizeDoc } from '../core/merge';
import { getRec, pendingKeys, planSync, sameRec, setRec, splitKey, type Change, type Conflict } from '../core/sync';
import type { Doc, Synced } from '../core/types';
import { platformLabel, servedOverHttp } from '../lib/platform';
import { uid } from './actions';
import { useStore } from './store';

// Device ↔ PC sync. The PC hub is the single source of truth.
// - Every device works fully offline; edits wait in a local queue ("pending").
// - Whenever the PC is reachable (home Wi-Fi or Tailscale), pending edits upload automatically
//   and everyone else's edits download.
// - If the same record was changed differently on two devices, nothing is overwritten:
//   it becomes a conflict and the user chooses which version to keep.

const POLL_MS = 4000;
const SYNCED_KEY = 'eos.synced.v1';
const REV_KEY = 'eos.syncrev.v1';

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

let synced: Doc = normalizeDoc(readJson<Doc>(SYNCED_KEY));
let rev = Number(localStorage.getItem(REV_KEY) ?? -1);
let sameOrigin: boolean | null = null;
let timer: number | undefined;
let busy = false;
let again = false;

function saveSynced() {
  try {
    localStorage.setItem(SYNCED_KEY, JSON.stringify(synced));
    localStorage.setItem(REV_KEY, String(rev));
  } catch {
    /* storage full — the next successful sync will retry */
  }
}

function hubBase(): string | null {
  if (sameOrigin) return '.';
  const url = useStore.getState().local.syncUrl.trim().replace(/\/$/, '');
  if (!url) return null;
  return /^https?:\/\//.test(url) ? url : `http://${url}`;
}

function headers(): Record<string, string> {
  const { syncPin, deviceName } = useStore.getState().local;
  return {
    'Content-Type': 'application/json',
    'X-EOS-DEVICE': (deviceName || platformLabel).slice(0, 60),
    ...(syncPin.trim() ? { 'X-EOS-PIN': syncPin.trim() } : {}),
  };
}

function openConflicts(): Map<string, Conflict> {
  return new Map(useStore.getState().conflicts.map((c) => [c.key, c]));
}

function updatePending() {
  const st = useStore.getState();
  const pending = pendingKeys(synced, st.doc, openConflicts()).length;
  if (pending !== st.sync.pending) st.setSync({ pending });
}

async function detectSameOrigin(): Promise<boolean> {
  if (!servedOverHttp()) return false;
  try {
    const res = await fetch('./api/ping', { cache: 'no-store' });
    if (!res.ok) return false;
    const j = (await res.json()) as { app?: string };
    return j.app === 'execution-os';
  } catch {
    return false;
  }
}

async function cycle() {
  if (busy) {
    again = true;
    return;
  }
  const base = hubBase();
  const store = useStore.getState();
  if (base === null) {
    store.setSync({ status: 'local', hub: null, error: undefined });
    updatePending();
    return;
  }
  busy = true;
  try {
    // 1. Download the PC's current state (or "nothing new").
    const res = await fetch(`${base}/api/sync?rev=${rev}`, { headers: headers(), cache: 'no-store' });
    if (res.status === 401) {
      store.setSync({ status: 'pin', error: 'Enter the pairing PIN shown on the PC.' });
      return;
    }
    if (!res.ok) throw new Error(`Hub returned ${res.status}`);
    const body = (await res.json()) as { rev: number; same?: boolean; doc?: Doc };
    const remote = body.same || !body.doc ? synced : normalizeDoc(body.doc);

    // 2. Decide record by record (no await between reading and writing local state).
    const now = Date.now();
    const st = useStore.getState();
    const open = openConflicts();
    const plan = planSync(synced, st.doc, remote, open, now);
    if (plan.changedLocal) st.replaceDoc(plan.local);
    if (plan.conflicts.length || plan.updatedConflicts.length) {
      const map = open;
      for (const c of [...plan.updatedConflicts, ...plan.conflicts]) map.set(c.key, c);
      st.setConflicts([...map.values()]);
      if (plan.conflicts.length) {
        st.toast(
          `${plan.conflicts.length} change${plan.conflicts.length > 1 ? 's' : ''} clash with the PC — choose which to keep.`,
          'warn',
          { label: 'Review', run: () => useStore.getState().open({ conflicts: true }) },
        );
      }
    }
    synced = remote;
    rev = body.rev;

    // 3. Upload this device's changes. The hub only accepts edits based on its latest version.
    let uploaded = 0;
    if (plan.push.length) {
      const before = synced;
      const pr = await fetch(`${base}/api/sync/push`, { method: 'POST', headers: headers(), body: JSON.stringify({ changes: plan.push }) });
      if (pr.status === 401) {
        store.setSync({ status: 'pin', error: 'Enter the pairing PIN shown on the PC.' });
        return;
      }
      if (!pr.ok) throw new Error(`Hub returned ${pr.status}`);
      const out = (await pr.json()) as { rev: number; accepted: number; rejected: { col: Change['col']; id: string }[]; doc: Doc };
      const hubDoc = normalizeDoc(out.doc);
      const rejected = new Set(out.rejected.map((r) => `${r.col}/${r.id}`));
      // Records the hub refused keep their old base, so the next cycle merges them properly.
      const nextSynced = structuredClone(hubDoc);
      for (const key of rejected) {
        const { col, id } = splitKey(key);
        setRec(nextSynced, col, id, getRec(before, col, id));
      }
      // Adopt the hub's stamped versions of what we uploaded (unless edited again meanwhile).
      const cur = useStore.getState().doc;
      const next = structuredClone(cur);
      let changed = false;
      for (const ch of plan.push) {
        if (rejected.has(`${ch.col}/${ch.id}`)) continue;
        if (sameRec(getRec(cur, ch.col, ch.id), ch.record)) {
          setRec(next, ch.col, ch.id, getRec(hubDoc, ch.col, ch.id));
          changed = true;
        }
      }
      if (changed) useStore.getState().replaceDoc(next);
      synced = nextSynced;
      rev = rejected.size ? -1 : out.rev;
      uploaded = out.accepted;
      if (rejected.size) again = true;
    }

    saveSynced();
    useStore.getState().setSync({
      status: 'online',
      hub: base === '.' ? 'same-origin' : 'remote',
      rev,
      lastAt: Date.now(),
      error: undefined,
      ...(uploaded ? { lastUploaded: uploaded } : {}),
    });
  } catch (err) {
    useStore.getState().setSync({ status: 'offline', error: (err as Error).message || 'PC not reachable' });
  } finally {
    busy = false;
    updatePending();
    if (again) {
      again = false;
      window.setTimeout(cycle, 300);
    }
  }
}

export async function startSync() {
  sameOrigin = await detectSameOrigin();
  if (sameOrigin) useStore.getState().setSync({ status: 'connecting', hub: 'same-origin' });
  await cycle();
  window.clearInterval(timer);
  timer = window.setInterval(cycle, POLL_MS);
  // Upload local edits quickly instead of waiting for the next poll.
  let pushTimer: number | undefined;
  useStore.subscribe((s, prev) => {
    if (s.ver !== prev.ver) {
      updatePending();
      window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(cycle, 600);
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void cycle();
  });
  window.addEventListener('online', () => void cycle());
}

export function syncNow() {
  void cycle();
}

/** The user's decision on a clash between this device and the PC. */
export function resolveConflict(key: string, choice: 'theirs' | 'mine' | 'both') {
  const st = useStore.getState();
  const c = st.conflicts.find((x) => x.key === key);
  if (!c) return;
  st.update((d, now) => {
    if (choice === 'theirs') {
      if (c.theirs) setRec(d, c.col, c.id, c.theirs);
    } else if (choice === 'mine') {
      setRec(d, c.col, c.id, { ...c.mine, u: now, r: c.theirs?.r });
    } else {
      const copyId = uid(c.id.split('-')[0] || 'x');
      const copy = { ...c.mine, id: copyId, u: now } as Synced;
      delete copy.r;
      setRec(d, c.col, copyId, copy);
      if (c.theirs) setRec(d, c.col, c.id, c.theirs);
    }
  });
  useStore.getState().setConflicts(useStore.getState().conflicts.filter((x) => x.key !== key));
  syncNow();
}

export async function testHub(url: string, pin: string): Promise<{ ok: boolean; message: string }> {
  const base = (/^https?:\/\//.test(url) ? url : `http://${url}`).replace(/\/$/, '');
  try {
    const ping = await fetch(`${base}/api/ping`, { cache: 'no-store' });
    const j = (await ping.json()) as { app?: string };
    if (j.app !== 'execution-os') return { ok: false, message: 'That address is not an Execution OS hub.' };
    const res = await fetch(`${base}/api/sync?rev=-1`, { headers: { 'X-EOS-PIN': pin } });
    if (res.status === 401) return { ok: false, message: 'Hub found, but the PIN is wrong.' };
    if (!res.ok) return { ok: false, message: `Hub error ${res.status}` };
    return { ok: true, message: 'Connected. This device now syncs with your PC.' };
  } catch {
    return { ok: false, message: 'Could not reach the PC. Is it on, with Execution OS running? Same Wi-Fi or Tailscale on?' };
  }
}
