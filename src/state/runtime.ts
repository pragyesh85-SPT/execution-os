import { useEffect } from 'react';
import { create } from 'zustand';
import { activeSession, blockAt, dayStatus, minutesForBlock, missionFor, planFor, proofFor, wakeDue } from '../core/engine';
import type { Doc, PlanBlock, Rule } from '../core/types';
import { clockOf, dayStartMs, fmtClock, logicalDate, MIN, offsetOf } from '../core/time';
import { notify, scheduleAhead } from '../lib/notify';
import { isAndroid, native } from '../lib/platform';
import { chime } from '../lib/sound';
import { stopSession } from './actions';
import { useStore } from './store';

// The heartbeat of the app: once per second it advances the clock, notices block changes,
// rings the wake gate, closes finished sessions (and asks for proof) and runs your IF→THEN rules.

export const useClock = create<{ now: number }>(() => ({ now: Date.now() }));
export const useNow = () => useClock((s) => s.now);

const FIRED_KEY = 'eos.fired.v1';
let fired: Record<string, string> = {};
try {
  fired = JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}') as Record<string, string>;
} catch {
  fired = {};
}

function fireOnce(key: string, date: string): boolean {
  if (fired[key]) return false;
  fired[key] = date;
  // forget keys from older days
  for (const [k, d] of Object.entries(fired)) if (d < date) delete fired[k];
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  } catch {
    /* ignore */
  }
  return true;
}

function runAction(rule: Rule, block: PlanBlock | undefined, date: string) {
  const st = useStore.getState();
  switch (rule.action.type) {
    case 'focus':
      if (block?.focus) st.open({ focus: true });
      break;
    case 'rescue':
      st.open({ rescue: true });
      st.toast('Rescue Mode: your rule asked to rebuild the day.', 'warn');
      break;
    case 'notify':
      st.toast(rule.action.message);
      void notify('Execution OS', rule.action.message);
      break;
    case 'unlock_ent':
      st.toast('All three outcomes done — optional entertainment is unlocked for today.', 'success');
      void notify('Outcomes complete', 'Optional entertainment is unlocked for today.');
      break;
    case 'save_later':
      break; // used by the "I feel an urge" flow
  }
  void date;
}

function onBlockChange(doc: Doc, date: string, prev: PlanBlock | undefined, next: PlanBlock | undefined, prevDate: string, now: number) {
  const st = useStore.getState();
  // Only ask for proof when the previous block really ended — not when a rescue just moved it later.
  const prevNow = prev ? planFor(doc, prevDate).blocks.find((b) => b.id === prev.id && !b.missed) : undefined;
  const ended = !!prevNow && dayStartMs(prevDate, doc.settings.dayStart) + prevNow.e * MIN <= now + 1500;
  if (prev && prevNow && ended && prev.focus && !proofFor(doc, prevDate, prev.id) && !st.overlay.proof && !st.overlay.wake) {
    st.open({ proof: { date: prevDate, blockId: prev.id }, focus: false });
  }
  if (!next) return;
  if (doc.settings.sound) chime();
  if (doc.settings.notifyBlocks && !isAndroid) {
    const plan = planFor(doc, date);
    const mission = missionFor(plan, next)?.title;
    void notify(next.title, `${mission ? mission + ' · ' : ''}until ${fmtClock(clockOf(next.e, doc.settings.dayStart))}`);
  }
  for (const r of Object.values(doc.rules)) {
    if (r.del || !r.enabled || r.trigger.type !== 'block_start') continue;
    if (r.trigger.category === next.category && fireOnce(`${r.id}:${date}:${next.id}`, date)) runAction(r, next, date);
  }
}

function runRules(doc: Doc, now: number, date: string, block: PlanBlock | undefined) {
  const off = offsetOf(now, date, doc.settings.dayStart);
  const plan = planFor(doc, date);
  for (const r of Object.values(doc.rules)) {
    if (r.del || !r.enabled) continue;
    const t = r.trigger;
    if (t.type === 'block_missed' && block && block.category === t.category && block.focus) {
      const started = minutesForBlock(doc, date, block.id, now) > 0 || activeSession(doc)?.blockId === block.id;
      if (!started && off - block.s >= t.minutes && fireOnce(`${r.id}:${date}:${block.id}`, date)) runAction(r, block, date);
    }
    if (t.type === 'outcomes_done' && plan.outcomes.length === 3 && plan.outcomes.every((o) => o.done)) {
      if (fireOnce(`${r.id}:${date}`, date)) runAction(r, block, date);
    }
    if (t.type === 'time') {
      const clock = clockOf(off, doc.settings.dayStart);
      if (clock >= t.at && clock < t.at + 2 && fireOnce(`${r.id}:${date}`, date)) runAction(r, block, date);
    }
  }
}

export function useRuntime() {
  useEffect(() => {
    let lastKey = '';
    let lastBlock: PlanBlock | undefined;
    let lastDate = '';

    const tick = () => {
      const now = Date.now();
      useClock.setState({ now });
      const st = useStore.getState();
      const doc = st.doc;
      const ds = doc.settings.dayStart;
      const date = logicalDate(now, ds);
      const plan = planFor(doc, date);
      const off = offsetOf(now, date, ds);
      const block = blockAt(plan, off);
      const key = `${date}:${block?.id ?? '-'}`;

      if (lastKey && key !== lastKey) onBlockChange(doc, date, lastBlock, block, lastDate, now);
      lastKey = key;
      lastBlock = block;
      lastDate = date;

      // Wake gate
      const w = wakeDue(doc, now);
      if (w.due && !st.overlay.wake && doc.settings.onboarded) st.open({ wake: true });
      if (!w.due && st.overlay.wake) st.open({ wake: false });

      // A running session whose block has ended is closed at the block's end, then proof is requested.
      const a = activeSession(doc);
      if (a) {
        const aPlan = planFor(doc, a.date);
        const ab = aPlan.blocks.find((b) => b.id === a.blockId);
        const endAbs = ab ? dayStartMs(a.date, ds) + ab.e * MIN : now;
        if (!ab || now >= endAbs) {
          stopSession(Math.min(now, endAbs));
          if (ab && !proofFor(doc, a.date, ab.id)) st.open({ proof: { date: a.date, blockId: ab.id }, focus: false });
        }
      }

      runRules(doc, now, date, block);

      // Auto-open Rescue when configured.
      if (doc.settings.autoRescue && doc.settings.onboarded) {
        const s = dayStatus(doc, now);
        if (s.state === 'rescue' && !st.overlay.rescue && !st.overlay.wake && fireOnce(`auto-rescue:${date}:${s.reason}:${s.block?.id ?? ''}`, date)) {
          st.open({ rescue: true });
        }
      }
    };

    tick();
    const id = window.setInterval(tick, 1000);

    // Native shells
    const offWake = native?.onWake(() => useStore.getState().open({ wake: true }));
    const offGuard = native?.onGuard((info) => useStore.getState().open({ guard: info }));

    // Android: keep OS notifications in step with the plan.
    scheduleAhead(useStore.getState().doc);
    const unsub = useStore.subscribe((s, prev) => {
      if (s.doc !== prev.doc) scheduleAhead(s.doc);
    });

    return () => {
      window.clearInterval(id);
      offWake?.();
      offGuard?.();
      unsub();
    };
  }, []);
}
