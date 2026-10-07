import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { LifeBuoy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { liveBlocks, wakeDue } from '../core/engine';
import { buildRescue } from '../core/rescue';
import type { PlanBlock } from '../core/types';
import { clockOf, fmtClock, fmtDur } from '../core/time';
import { EASE, Segmented, Sheet, catColor } from '../components/ui';
import { applyRescue, dismissRescue } from '../state/actions';
import { useToday } from '../state/hooks';
import { useStore } from '../state/store';
import { successTone } from '../lib/sound';

// Rescue Mode: rebuild the rest of the day instead of declaring it failed.
// Shows the current plan morphing into the rescued plan before you accept it.

export function RescueSheet() {
  const open = useStore((s) => s.overlay.rescue);
  const setOpen = useStore((s) => s.open);
  return (
    <AnimatePresence>
      {open && <RescueInner key="rescue" onClose={() => setOpen({ rescue: false })} />}
    </AnimatePresence>
  );
}

function RescueInner({ onClose }: { onClose: () => void }) {
  const { doc, date, plan, ds } = useToday();
  const toast = useStore((s) => s.toast);
  // Freeze "now" when the sheet opens so the preview does not shift every second.
  const [frozenNow] = useState(() => Date.now());
  const lateWake = useMemo(() => {
    const w = doc.wake[date];
    if (w && !w.del) return w.lateMin;
    return wakeDue(doc, frozenNow).lateMin;
  }, [doc, date, frozenNow]);
  const result = useMemo(() => buildRescue(doc, date, frozenNow, { lateWakeMin: lateWake > doc.settings.rescueMin ? lateWake : 0 }), [doc, date, frozenNow, lateWake]);
  const [phase, setPhase] = useState<'before' | 'after'>('before');
  useEffect(() => {
    const t = window.setTimeout(() => setPhase('after'), 650);
    return () => window.clearTimeout(t);
  }, []);

  const from = result.from;
  const span = Math.max(1, 1440 - from);
  const before = liveBlocks(plan).filter((b) => b.e > from);
  const after = result.blocks.filter((b) => b.e > from && !b.missed);
  const shown = phase === 'before' ? before : after;
  const pos = (b: PlanBlock) => {
    const s = Math.max(b.s, from);
    return { left: `${((s - from) / span) * 100}%`, width: `${((b.e - s) / span) * 100}%` };
  };

  return (
    <Sheet
      open
      wide
      onClose={onClose}
      title={
        <span className="row" style={{ gap: 10 }}>
          <LifeBuoy size={20} color="var(--bad)" /> Rescue Mode
        </span>
      }
      subtitle="Lateness is not carried forward block by block. The rest of today is rebuilt to be feasible."
      footer={
        <>
          <button
            className="btn ghost"
            onClick={() => {
              dismissRescue(date);
              onClose();
            }}
          >
            Not now
          </button>
          <button
            className="btn primary"
            onClick={() => {
              applyRescue(date, result);
              successTone();
              toast('Rescued plan applied. One block at a time from here.', 'success');
              onClose();
            }}
          >
            Apply rescued plan
          </button>
        </>
      }
    >
      <div className="stack lg">
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
          {result.summary.map((s, i) => (
            <motion.li key={s} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 + i * 0.06, duration: 0.25, ease: EASE }}>
              {s}
            </motion.li>
          ))}
        </ul>

        <div>
          <div className="row between" style={{ marginBottom: 10 }}>
            <span className="mono faint" style={{ fontSize: 12 }}>
              {fmtClock(clockOf(from, ds))} → {fmtClock(clockOf(1440, ds))}
            </span>
            <Segmented
              id="rescue-phase"
              value={phase}
              onChange={setPhase}
              options={[
                { value: 'before', label: 'Current' },
                { value: 'after', label: 'Rescued' },
              ]}
            />
          </div>
          <LayoutGroup>
            <div style={{ position: 'relative', height: 44, borderRadius: 10, background: 'var(--surface-2)', overflow: 'hidden' }}>
              <AnimatePresence initial={false}>
                {shown.map((b) => (
                  <motion.div
                    key={b.id}
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.6, ease: EASE }}
                    title={`${b.title} · ${fmtDur(b.e - Math.max(b.s, from))}`}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      ...pos(b),
                      background: catColor(b.category),
                      borderRadius: 6,
                      borderLeft: '2px solid var(--surface)',
                    }}
                  />
                ))}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        </div>

        <div className="timeline">
          <AnimatePresence mode="popLayout" initial={false}>
            {shown.map((b) => (
              <motion.div
                layout
                key={`row-${b.id}`}
                className="tl-row"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
              >
                <span className="tl-time">{fmtClock(clockOf(Math.max(b.s, from), ds))}</span>
                <span className="tl-bar" style={{ background: catColor(b.category) }} />
                <div>
                  <div className="tl-title">{b.title}</div>
                  <div className="tl-sub">
                    {CATEGORY_META[b.category].label}
                    {b.fixed ? ' · fixed anchor' : ''}
                  </div>
                </div>
                <span className="tl-sub mono">{fmtDur(b.e - Math.max(b.s, from))}</span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {result.dropped.some((b) => b.focus) && (
          <p className="faint" style={{ margin: 0, fontSize: 13 }}>
            Missions from dropped focus blocks are moved to your task inbox — nothing disappears silently.
          </p>
        )}
      </div>
    </Sheet>
  );
}
