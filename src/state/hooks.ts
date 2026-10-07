import { useMemo } from 'react';
import { activeSession, blockAt, dayStatus, liveBlocks, nextBlocks, planFor } from '../core/engine';
import { logicalDate, offsetOf } from '../core/time';
import { useNow } from './runtime';
import { useStore } from './store';

/** Everything the Today view needs, recomputed every second. */
export function useToday() {
  const doc = useStore((s) => s.doc);
  const now = useNow();
  const ds = doc.settings.dayStart;
  const date = logicalDate(now, ds);
  const plan = useMemo(() => planFor(doc, date), [doc, date]);
  const off = offsetOf(now, date, ds);
  const block = blockAt(plan, off);
  const next = nextBlocks(plan, off, 3);
  const status = dayStatus(doc, now);
  const session = activeSession(doc);
  return { doc, now, date, plan, off, block, next, status, session, blocks: liveBlocks(plan), ds };
}
