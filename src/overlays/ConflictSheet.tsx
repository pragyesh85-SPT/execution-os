import { AnimatePresence, motion } from 'motion/react';
import { GitMerge, Laptop, Smartphone } from 'lucide-react';
import { describeRec, type Conflict } from '../core/sync';
import { EASE, Sheet } from '../components/ui';
import { isAndroid, isElectron, platformLabel } from '../lib/platform';
import { resolveConflict } from '../state/sync';
import { useStore } from '../state/store';

// When the same thing was changed differently on two devices, the user decides.

const KEEP_BOTH: Conflict['col'][] = ['tasks', 'later', 'rules', 'distractions'];

function valueAt(obj: unknown, path: string): unknown {
  if (path === '(whole record)') return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    const texts = v.map((x) => (x && typeof x === 'object' ? ((x as Record<string, unknown>).text ?? (x as Record<string, unknown>).title ?? (x as Record<string, unknown>).id) : x));
    return texts.filter((t) => t !== undefined).join(' · ') || `${v.length} items`;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.title === 'string') return o.title;
    if (typeof o.text === 'string') return o.text;
    return JSON.stringify(v).slice(0, 160);
  }
  return String(v);
}

const NAMES: Record<string, string> = {
  outcomes: 'Daily outcomes',
  missions: 'Missions',
  blocks: 'Time blocks',
  title: 'Title',
  done: 'Done',
  deadline: 'Deadline',
  estimate: 'Estimate (min)',
  priority: 'Priority',
  notes: 'Notes',
  status: 'Result',
  note: 'Note',
  steps: 'Steps',
  name: 'Name',
  enabled: 'On / off',
};

const label = (path: string) =>
  path === '(whole record)'
    ? 'Whole item'
    : NAMES[path] ??
      path
        .split('.')
        .map((p) => p.replace(/^b-/, '').replace(/([A-Z])/g, ' $1'))
        .join(' › ');

export function ConflictSheet() {
  const open = useStore((s) => s.overlay.conflicts);
  const conflicts = useStore((s) => s.conflicts);
  const setOpen = useStore((s) => s.open);
  const here = isElectron ? 'this PC app' : isAndroid ? 'this phone' : platformLabel.toLowerCase();
  const HereIcon = isAndroid ? Smartphone : Laptop;

  return (
    <Sheet
      open={open && conflicts.length > 0}
      onClose={() => setOpen({ conflicts: false })}
      wide
      title={
        <span className="row" style={{ gap: 10 }}>
          <GitMerge size={20} /> {conflicts.length} change{conflicts.length === 1 ? '' : 's'} need your decision
        </span>
      }
      subtitle="The same item was changed differently on two devices. Everything else merged automatically — only these clash. Nothing has been overwritten."
    >
      <div className="stack lg">
        <AnimatePresence initial={false}>
          {conflicts.map((c) => (
            <motion.div
              key={c.key}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 30, transition: { duration: 0.2 } }}
              transition={{ duration: 0.25, ease: EASE }}
              className="card flat"
              style={{ padding: 16 }}
            >
              <div className="row between wrap" style={{ marginBottom: 10 }}>
                <strong>{describeRec(c.col, c.mine)}</strong>
                <span className="faint" style={{ fontSize: 12 }}>
                  noticed {new Date(c.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 0.6fr) 1fr 1fr', gap: '6px 12px', fontSize: 14 }}>
                <span />
                <span className="row faint" style={{ gap: 6, fontSize: 12 }}>
                  <HereIcon size={14} /> On {here}
                </span>
                <span className="row faint" style={{ gap: 6, fontSize: 12 }}>
                  <Laptop size={14} /> On the PC (hub)
                </span>
                {c.fields.map((f) => (
                  <div key={f} style={{ display: 'contents' }}>
                    <span className="faint">{label(f)}</span>
                    <span style={{ padding: '6px 8px', borderRadius: 8, background: 'var(--surface)' }}>{show(valueAt(c.mine, f))}</span>
                    <span style={{ padding: '6px 8px', borderRadius: 8, background: 'var(--surface)' }}>{show(valueAt(c.theirs, f))}</span>
                  </div>
                ))}
              </div>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button className="btn" onClick={() => resolveConflict(c.key, 'mine')}>
                  Keep {here}'s version
                </button>
                <button className="btn" onClick={() => resolveConflict(c.key, 'theirs')}>
                  Keep the PC's version
                </button>
                {KEEP_BOTH.includes(c.col) && (
                  <button className="btn ghost" onClick={() => resolveConflict(c.key, 'both')}>
                    Keep both
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Sheet>
  );
}
