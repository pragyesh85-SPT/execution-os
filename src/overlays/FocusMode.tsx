import { AnimatePresence, motion } from 'motion/react';
import { Flag, Minimize2, Pause, Play, ShieldOff, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { minutesForBlock, missionFor } from '../core/engine';
import { clockOf, fmtClock, fmtCountdown, fmtDur, MIN } from '../core/time';
import { EASE, RollingDigits, catColor } from '../components/ui';
import { pauseGuard, startSession, stopSession, toggleStep } from '../state/actions';
import { useToday } from '../state/hooks';
import { useStore } from '../state/store';

// Focus Mode: one mission, one clock, nothing else on screen.

export function FocusMode() {
  const openState = useStore((s) => s.overlay.focus);
  const open = useStore((s) => s.open);
  const { block } = useToday();
  const visible = openState && !!block && block.focus;

  useEffect(() => {
    if (!visible) return;
    let lock: WakeLockSentinel | null = null;
    void navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && open({ focus: false });
    window.addEventListener('keydown', onKey);
    return () => {
      void lock?.release();
      window.removeEventListener('keydown', onKey);
    };
  }, [visible, open]);

  return <AnimatePresence>{visible && <FocusScreen key="focus" />}</AnimatePresence>;
}

function FocusScreen() {
  const { doc, now, date, plan, off, block, session, ds } = useToday();
  const open = useStore((s) => s.open);
  const toast = useStore((s) => s.toast);
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<number | undefined>(undefined);
  if (!block) return null;

  const mission = missionFor(plan, block);
  const len = block.e - block.s;
  const remainingMs = (block.e - off) * MIN;
  const frac = Math.max(0, Math.min(1, (off - block.s) / len));
  const running = session?.blockId === block.id;
  const tracked = minutesForBlock(doc, date, block.id, now);
  const color = catColor(block.category);
  const r = 47;
  const circ = 2 * Math.PI * r;
  const paused = plan.guardPausedUntil && plan.guardPausedUntil > now;

  const startHold = () => {
    setHolding(true);
    holdTimer.current = window.setTimeout(() => {
      setHolding(false);
      pauseGuard(date, 10);
      toast('Focus Guard paused for 10 minutes. It comes back on by itself.', 'warn');
    }, 2000);
  };
  const endHold = () => {
    setHolding(false);
    window.clearTimeout(holdTimer.current);
  };

  return (
    <motion.div
      className="focus-screen"
      layoutId="focus-surface"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
      style={{ borderRadius: 0 }}
    >
      <motion.div className="focus-top" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25 }}>
        <div className="row">
          <span className="dot" style={{ background: color, width: 10, height: 10 }} />
          <span style={{ fontWeight: 500 }}>{block.title}</span>
          <span className="mono" style={{ color: 'var(--ink-3)', fontSize: 13 }}>
            {fmtClock(clockOf(block.s, ds))} → {fmtClock(clockOf(block.e, ds))}
          </span>
        </div>
        <button className="btn ghost sm" onClick={() => open({ focus: false })}>
          <Minimize2 size={14} /> Exit focus view
        </button>
      </motion.div>

      <div className="focus-center">
        <motion.div className="focus-ring" initial={{ scale: 0.92, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.15, duration: 0.5, ease: EASE }}>
          <svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r={r} fill="none" stroke="#2c2a27" strokeWidth="2.5" />
            <motion.circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke={color}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={circ}
              initial={{ strokeDashoffset: circ }}
              animate={{ strokeDashoffset: circ * frac }}
              transition={{ duration: 0.9, ease: EASE }}
            />
          </svg>
          <div className="inner">
            <RollingDigits text={fmtCountdown(remainingMs)} />
            <span style={{ color: 'var(--ink-3)', fontSize: 13 }}>
              {running ? `in focus · ${fmtDur(tracked)} tracked` : tracked > 0 ? `paused · ${fmtDur(tracked)} tracked` : 'not started'}
            </span>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3, duration: 0.35, ease: EASE }} className="stack" style={{ justifyItems: 'center' }}>
          <span style={{ color: 'var(--ink-3)', fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{CATEGORY_META[block.category].label} · objective</span>
          <div className="focus-mission">{mission?.title ?? 'No mission set — name the one result for this block before you start.'}</div>
        </motion.div>

        {mission && mission.steps.length > 0 && (
          <motion.div className="focus-steps" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
            {mission.steps.map((s) => (
              <button key={s.id} className="focus-step" data-done={s.done} onClick={() => toggleStep(date, block, s.id)}>
                <span className="check" data-on={s.done} style={{ pointerEvents: 'none' }}>
                  {s.done && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span>{s.text}</span>
              </button>
            ))}
          </motion.div>
        )}
      </div>

      <motion.div className="focus-bottom" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.35 }}>
        {running ? (
          <button className="btn lg" onClick={() => stopSession()}>
            <Pause size={18} /> Pause
          </button>
        ) : (
          <button className="btn primary lg" onClick={() => startSession(date, block)}>
            <Play size={18} /> {tracked > 0 ? 'Resume' : 'Start'}
          </button>
        )}
        <button
          className="btn lg"
          onClick={() => {
            stopSession();
            open({ focus: false, proof: { date, blockId: block.id } });
          }}
        >
          <Flag size={16} /> Finish &amp; record proof
        </button>
        <button className="btn ghost lg" onClick={() => open({ urge: true })}>
          <Sparkles size={16} /> I feel an urge
        </button>
        {!paused && (
          <button className="btn ghost lg hold-btn" onPointerDown={startHold} onPointerUp={endHold} onPointerLeave={endHold} title="Hold for 2 seconds">
            <AnimatePresence>
              {holding && <motion.i className="fill" initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} exit={{ opacity: 0 }} transition={{ duration: 2, ease: 'linear' }} />}
            </AnimatePresence>
            <span className="row" style={{ gap: 8 }}>
              <ShieldOff size={16} /> Hold to pause guard
            </span>
          </button>
        )}
      </motion.div>
    </motion.div>
  );
}
