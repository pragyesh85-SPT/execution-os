import { motion } from 'motion/react';
import { Lock, Pin } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { isAnchor } from '../core/ops';
import type { Doc, PlanBlock } from '../core/types';
import { clockOf, fmtClock } from '../core/time';
import { attempt, pinBlock } from '../state/actions';
import { useFlag } from '../state/hooks';
import { useStore } from '../state/store';
import { catColor } from './ui';

// One block in a day list (Now and Plan). Tap does the row's main action; long-press on a phone
// or right-click on a desktop opens the block sheet (pin, edit time, mission).

export function PinButton({ doc, date, block }: { doc: Doc; date: string; block: PlanBlock }) {
  const pins = useFlag('pins');
  const toast = useStore((s) => s.toast);
  if (!pins || block.missed) return null;
  if (isAnchor(doc, block)) {
    return (
      <span className="pin-btn anchor" title="Anchor — edit in Clock" aria-label="Anchor — edit in Clock">
        <Lock size={13} />
      </span>
    );
  }
  if (block.category === 'buffer' || block.exception) return null;
  return (
    <button
      type="button"
      className="pin-btn"
      data-on={!!block.pinned}
      aria-pressed={!!block.pinned}
      aria-label={block.pinned ? `Unpin ${block.title}` : `Pin ${block.title} to its time`}
      title={block.pinned ? 'Pinned — Rescue never moves it. Tap to unpin.' : 'Pin to this time'}
      onClick={(e) => {
        e.stopPropagation();
        if (attempt(() => pinBlock(date, block.id, !block.pinned))) {
          toast(block.pinned ? `${block.title} unpinned.` : `${block.title} pinned — Rescue will build around it.`, 'success');
        }
      }}
    >
      <Pin size={13} />
    </button>
  );
}

export function BlockRow(props: {
  doc: Doc;
  date: string;
  block: PlanBlock;
  sub: ReactNode;
  right?: ReactNode;
  current?: boolean;
  past?: boolean;
  onClick?: () => void;
  dot?: 'amber';
}) {
  const { doc, date, block: b, sub, right, current, past, onClick, dot } = props;
  const open = useStore((s) => s.open);
  const timer = useRef<number | undefined>(undefined);
  const longPressed = useRef(false);
  const ds = doc.settings.dayStart;
  const openSheet = () => !b.missed && open({ block: { date, blockId: b.id } });
  const cancel = () => window.clearTimeout(timer.current);
  return (
    <motion.div
      layout
      className="tl-row"
      data-current={!!current}
      data-past={!!past}
      data-missed={!!b.missed}
      data-pinned={!!b.pinned}
      onClick={() => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        (onClick ?? openSheet)();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openSheet();
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        longPressed.current = false;
        timer.current = window.setTimeout(() => {
          longPressed.current = true;
          openSheet();
        }, 500);
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      style={{ cursor: 'pointer' }}
    >
      <span className="tl-time">{fmtClock(clockOf(b.s, ds))}</span>
      <span className="tl-bar" style={{ background: catColor(b.category) }} />
      <div style={{ minWidth: 0 }}>
        <div className="tl-title">
          {b.title}
          {dot === 'amber' && <span className="unlogged-dot" title="Finished — not logged yet" />}
        </div>
        <div className="tl-sub">{sub}</div>
      </div>
      <span className="row" style={{ gap: 6 }}>
        <span className="tl-sub mono">{right}</span>
        <PinButton doc={doc} date={date} block={b} />
      </span>
    </motion.div>
  );
}
