import { motion } from 'motion/react';
import { ArrowRight, CircleMinus, CirclePlus, Clock4, LifeBuoy, Lock, Pin, Scissors, Split } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { dayStatus, liveBlocks, wakeDue } from '../core/engine';
import { buildWeekRescue, rescueOptions, STRATEGY_LABEL, type RescueChangeLine, type RescueResult, type WeekRescueResult } from '../core/rescue';
import { slotRates } from '../core/stats';
import type { PlanBlock, RescueReason, RescueStrategy } from '../core/types';
import { clockOf, fmtClock, fmtDur, shortDate } from '../core/time';
import { EASE, Sheet, catColor } from '../components/ui';
import { applyRescue, applyWeekRescue, attempt, dismissRescue } from '../state/actions';
import { useToday } from '../state/hooks';
import { useStore } from '../state/store';
import { successTone } from '../lib/sound';

// Rescue v2: up to three strategies, a before/after timeline with fixed blocks greyed,
// one sentence for every change, and apply for today or for the rest of the week.

export interface RescueApply {
  today: (date: string, r: RescueResult, reason: RescueReason) => boolean;
  week: (w: WeekRescueResult, reason: RescueReason) => boolean;
}

const directApply: RescueApply = {
  today: (date, r, reason) => attempt(() => applyRescue(date, r, { reason })),
  week: (w, reason) => attempt(() => applyWeekRescue(w, { reason })),
};

const LINE_ICON: Record<RescueChangeLine['kind'], ReactNode> = {
  kept: <Lock size={14} />,
  moved: <ArrowRight size={14} />,
  shortened: <Scissors size={14} />,
  split: <Split size={14} />,
  dropped: <CircleMinus size={14} />,
  added: <CirclePlus size={14} />,
};

export function RescueV2({ onClose, apply = directApply }: { onClose: () => void; apply?: RescueApply }) {
  const { doc, date, plan, ds } = useToday();
  const toast = useStore((s) => s.toast);
  const [frozenNow] = useState(() => Date.now());
  const lateWake = useMemo(() => {
    const w = doc.wake[date];
    if (w && !w.del) return w.lateMin;
    return wakeDue(doc, frozenNow).lateMin;
  }, [doc, date, frozenNow]);
  const reason: RescueReason = useMemo(() => dayStatus(doc, frozenNow).reason ?? 'manual', [doc, frozenNow]);
  const computed = useMemo(() => {
    try {
      const rates = slotRates(doc, date, frozenNow);
      const opts = { lateWakeMin: lateWake > doc.settings.rescueMin ? lateWake : 0, slotRates: rates };
      return { options: rescueOptions(doc, date, frozenNow, opts), opts, error: null as string | null };
    } catch (e) {
      return { options: [] as RescueResult[], opts: {}, error: (e as Error).message };
    }
  }, [doc, date, frozenNow, lateWake]);
  const [strategy, setStrategy] = useState<RescueStrategy | null>(null);
  const result = computed.options.find((o) => o.strategy === strategy) ?? computed.options[0];
  const week = useMemo(() => (result ? buildWeekRescue(doc, date, frozenNow, { ...computed.opts, strategy: result.strategy }) : null), [doc, date, frozenNow, computed.opts, result]);

  if (!result || !week) {
    return (
      <Sheet open onClose={onClose} title="Rescue Mode" subtitle="Something went wrong while rebuilding the day.">
        <p style={{ color: 'var(--bad)' }}>{computed.error ?? 'No rescue could be built.'}</p>
      </Sheet>
    );
  }

  const from = result.from;
  const span = Math.max(1, 1440 - from);
  const before = liveBlocks(plan).filter((b) => b.e > from);
  const after = result.blocks.filter((b) => b.e > from && !b.missed);
  const weekChanges = week.days.reduce((a, d) => a + d.lines.length, 0);

  const done = (msg: string) => {
    successTone();
    toast(msg, 'success');
    onClose();
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
      subtitle="Lateness is not carried forward block by block. The rest of today is rebuilt around your pins and anchors."
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
          <button className="btn" onClick={() => apply.week(week, reason) && done(weekChanges ? `Applied for the week: today rebuilt, ${weekChanges} mission${weekChanges > 1 ? 's' : ''} moved to later days.` : 'Applied for the week. Nothing needed to move to later days.')}>
            Apply for the week
          </button>
          <button className="btn primary" onClick={() => apply.today(date, result, reason) && done('Rescued plan applied. One block at a time from here.')}>
            Apply for today
          </button>
        </>
      }
    >
      <div className="stack lg">
        {computed.options.length > 1 && (
          <div className="stack" style={{ gap: 8 }}>
            <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Rescue strategy">
              {computed.options.map((o) => (
                <button key={o.strategy} type="button" className="strategy-chip" aria-pressed={o.strategy === result.strategy} onClick={() => setStrategy(o.strategy)}>
                  {STRATEGY_LABEL[o.strategy]}
                </button>
              ))}
            </div>
            {result.headline && <p className="muted" style={{ margin: 0, fontSize: 14 }}>{result.headline}</p>}
          </div>
        )}

        <div className="row wrap" style={{ gap: 8 }}>
          {result.pinnedCount > 0 && (
            <span className="chip">
              <Pin size={12} /> Includes {result.pinnedCount} pinned block{result.pinnedCount > 1 ? 's' : ''}
            </span>
          )}
          <span className="chip">
            <Clock4 size={12} /> {fmtDur(result.freeMinutes)} of flexible time left
          </span>
          {!result.feasible && <span className="chip" style={{ color: 'var(--bad)' }}>Over-constrained</span>}
        </div>

        <div className="stack" style={{ gap: 6 }}>
          <div className="row between">
            <span className="mono faint" style={{ fontSize: 12 }}>
              {fmtClock(clockOf(from, ds))} → {fmtClock(clockOf(1440, ds))}
            </span>
            <span className="faint" style={{ fontSize: 12 }}>
              <span className="fixed-swatch" /> fixed
            </span>
          </div>
          <TimelineBar label="Now" blocks={before} from={from} span={span} ds={ds} />
          <TimelineBar label="After" blocks={after} from={from} span={span} ds={ds} animateKey={result.strategy} />
        </div>

        <ul className="rescue-lines">
          {result.lines.map((l, i) => (
            <motion.li key={`${l.kind}-${l.blockId}-${i}`} data-kind={l.kind} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 + i * 0.03, duration: 0.22, ease: EASE }}>
              <span className="ic">{LINE_ICON[l.kind]}</span>
              <span>{l.reason}</span>
            </motion.li>
          ))}
        </ul>

        {!result.feasible && result.summary[0]?.startsWith('Over-constrained') && <p style={{ margin: 0, color: 'var(--bad)', fontSize: 14 }}>{result.summary[0]}</p>}

        {(week.days.length > 0 || week.toInbox.length > 0) && (
          <div className="stack" style={{ gap: 6 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              If you apply for the week
            </h3>
            {week.days.map((d) => (
              <div key={d.date} className="faint" style={{ fontSize: 14 }}>
                <strong style={{ color: 'var(--ink)' }}>{shortDate(d.date)}</strong> · {d.lines.map((l) => l.reason).join(' ')}
              </div>
            ))}
            {week.toInbox.length > 0 && (
              <div className="faint" style={{ fontSize: 14 }}>
                To the task inbox (no free focus block this week): {week.toInbox.map((x) => `“${x.title}”`).join(', ')}
              </div>
            )}
          </div>
        )}
        {week.days.length === 0 && result.dropped.some((b) => b.focus) && (
          <p className="faint" style={{ margin: 0, fontSize: 13 }}>
            Missions from dropped focus blocks go to your task inbox — nothing disappears silently.
          </p>
        )}
      </div>
    </Sheet>
  );
}

function TimelineBar({ label, blocks, from, span, ds, animateKey }: { label: string; blocks: PlanBlock[]; from: number; span: number; ds: number; animateKey?: string }) {
  const pos = (b: PlanBlock) => {
    const s = Math.max(b.s, from);
    return { left: `${((s - from) / span) * 100}%`, width: `${((b.e - s) / span) * 100}%` };
  };
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="faint mono" style={{ width: 40, fontSize: 11 }}>
        {label}
      </span>
      <div className="rescue-bar" key={animateKey}>
        {blocks.map((b) => (
          <motion.div
            key={b.id}
            className="seg-block"
            data-fixed={b.fixed}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.35, ease: EASE }}
             title={`${b.title} · ${fmtClock(clockOf(Math.max(b.s, from), ds))} · ${fmtDur(b.e - Math.max(b.s, from))}${b.fixed ? ' · fixed' : ''}`}
            style={{ ...pos(b), background: b.fixed ? undefined : catColor(b.category) }}
          >
            {b.pinned && <Pin size={10} />}
          </motion.div>
        ))}
      </div>
      <span className="sr-only">{blocks.map((b) => `${CATEGORY_META[b.category].short} ${fmtDur(b.e - b.s)}`).join(', ')}</span>
    </div>
  );
}
