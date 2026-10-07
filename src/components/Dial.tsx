import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import type { PlanBlock } from '../core/types';
import { clockOf, fmtClock, fmtDur } from '../core/time';
import { EASE, catColor } from './ui';

// The live 24-hour clock: midnight at the top, every life block as an arc,
// the vermilion hand is "now". Past time is dimmed, the current block is lifted.

const C = 200;
const R = 150;
const W = 30;

function polar(r: number, angleDeg: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

function arcPath(r: number, a0: number, a1: number) {
  const sweep = Math.max(0.01, a1 - a0);
  const p0 = polar(r, a0);
  const p1 = polar(r, a0 + sweep);
  const large = sweep > 180 ? 1 : 0;
  return `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

const deg = (clock: number) => (clock / 1440) * 360;

export function Dial(props: {
  blocks: PlanBlock[];
  dayStart: number;
  nowOffset: number;
  done?: (b: PlanBlock) => boolean;
  size?: number;
  interactive?: boolean;
  centerTop?: string;
  centerSub?: string;
  onSelect?: (b: PlanBlock) => void;
}) {
  const { blocks, dayStart, nowOffset, done, interactive = true, onSelect } = props;
  const [hover, setHover] = useState<PlanBlock | null>(null);
  const nowClock = clockOf(nowOffset, dayStart);
  // unwrapped within the logical day so the hand never spins backwards at midnight
  const nowAngle = deg(dayStart + nowOffset);

  const arcs = useMemo(
    () =>
      blocks
        .filter((b) => b.e > b.s)
        .map((b) => {
          const startClock = clockOf(b.s, dayStart);
          const len = b.e - b.s;
          const a0 = deg(startClock) + 0.7;
          const a1 = deg(startClock) + deg(len) - 0.7;
          return { b, a0, a1 };
        }),
    [blocks, dayStart],
  );

  const current = blocks.find((b) => !b.missed && nowOffset >= b.s && nowOffset < b.e);
  const shown = hover ?? current ?? null;
  const hourMarks = Array.from({ length: 24 }, (_, h) => h);
  const labels: Record<number, string> = { 0: '12 AM', 6: '6 AM', 12: '12 PM', 18: '6 PM' };

  return (
    <div className="dial-wrap">
      <svg viewBox="0 0 400 400" role="img" aria-label="24-hour schedule clock">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="3" height="6" fill="var(--line-strong)" />
          </pattern>
        </defs>
        <circle cx={C} cy={C} r={R} fill="none" stroke="var(--surface-2)" strokeWidth={W} />
        {hourMarks.map((h) => {
          const a = deg(h * 60);
          const major = h % 6 === 0;
          const p0 = polar(R + W / 2 + 6, a);
          const p1 = polar(R + W / 2 + (major ? 14 : 10), a);
          return <line key={h} x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke="var(--ink-3)" strokeWidth={major ? 1.6 : 1} opacity={major ? 0.9 : 0.5} />;
        })}
        {Object.entries(labels).map(([h, text]) => {
          const p = polar(R + W / 2 + 30, deg(Number(h) * 60));
          return (
            <text key={h} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" fontSize="11" fill="var(--ink-3)" fontFamily="var(--font-mono)">
              {text}
            </text>
          );
        })}
        {arcs.map(({ b, a0, a1 }, i) => {
          const isCurrent = current?.id === b.id;
          const past = b.e <= nowOffset;
          const isDone = done?.(b);
          return (
            <motion.path
              key={b.id}
              className="arc"
              d={arcPath(R, a0, a1)}
              fill="none"
              stroke={b.missed ? 'url(#hatch)' : catColor(b.category)}
              strokeLinecap="butt"
              initial={{ pathLength: 0, opacity: 0, strokeWidth: W }}
              animate={{
                pathLength: 1,
                opacity: b.missed ? 0.6 : past ? (isDone ? 0.55 : 0.3) : hover && hover.id !== b.id ? 0.55 : 1,
                strokeWidth: isCurrent ? W + 12 : hover?.id === b.id ? W + 6 : W,
              }}
              transition={{
                pathLength: { duration: 0.7, delay: 0.1 + i * 0.045, ease: EASE },
                opacity: { duration: 0.25 },
                strokeWidth: { type: 'spring', stiffness: 380, damping: 26 },
              }}
              onMouseEnter={interactive ? () => setHover(b) : undefined}
              onMouseLeave={interactive ? () => setHover(null) : undefined}
              onClick={interactive ? () => (onSelect ? onSelect(b) : setHover(hover?.id === b.id ? null : b)) : undefined}
            >
              <title>{`${b.title} · ${fmtClock(clockOf(b.s, dayStart))}–${fmtClock(clockOf(b.e, dayStart))}`}</title>
            </motion.path>
          );
        })}
        {/* now hand */}
        <g style={{ transform: `rotate(${nowAngle}deg)`, transformOrigin: '200px 200px', transition: 'transform 1s linear' }}>
          <line x1={C} y1={C - 64} x2={C} y2={C - R - W / 2 - 8} stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx={C} cy={C - R - W / 2 - 10} r="5" fill="var(--accent)" />
        </g>
      </svg>
      <div className="dial-center">
        <div className="clock">{props.centerTop ?? fmtClock(nowClock).replace(/ (AM|PM)$/, '')}</div>
        <div className="sub">{props.centerSub ?? (nowClock < 720 ? 'AM' : 'PM')}</div>
        {shown && (
          <motion.div key={shown.id} className="hover" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
            <strong style={{ color: catColor(shown.category) }}>{CATEGORY_META[shown.category].short}</strong> · {shown.title}
            <br />
            <span className="mono">
              {fmtClock(clockOf(shown.s, dayStart))}–{fmtClock(clockOf(shown.e, dayStart))} · {fmtDur(shown.e - shown.s)}
            </span>
          </motion.div>
        )}
      </div>
    </div>
  );
}
