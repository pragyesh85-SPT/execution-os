import { normalizeDoc } from '../core/merge';
import * as ops from '../core/ops';
import type { Op } from '../core/ops';
import type { Doc } from '../core/types';
import { logicalDate } from '../core/time';
import { useStore } from './store';

// UI actions. Every edit is a pure op from src/core/ops.ts run through the store,
// so the hub (and the AI connector) can apply exactly the same changes.

export const uid = (prefix: string) => ops.uid(prefix);
export const { carve, ensurePlan } = ops;

const up = (op: Op<unknown>) => useStore.getState().update(op);

export function today(): string {
  const d = useStore.getState().doc;
  return logicalDate(Date.now(), d.settings.dayStart);
}

// ---------- sessions / proof ----------
export const startSession = (...a: Parameters<typeof ops.startSession>) => up(ops.startSession(...a));
export const stopSession = (...a: Parameters<typeof ops.stopSession>) => up(ops.stopSession(...a));
export const saveProof = (...a: Parameters<typeof ops.saveProof>) => up(ops.saveProof(...a));
export const clearProof = (...a: Parameters<typeof ops.clearProof>) => up(ops.clearProof(...a));

// ---------- wake ----------
export const verifyWake = (...a: Parameters<typeof ops.verifyWake>) => up(ops.verifyWake(...a));
export const bypassWake = (...a: Parameters<typeof ops.bypassWake>) => up(ops.bypassWake(...a));

// ---------- outcomes & missions ----------
export const setOutcomes = (...a: Parameters<typeof ops.setOutcomes>) => up(ops.setOutcomes(...a));
export const toggleOutcome = (...a: Parameters<typeof ops.toggleOutcome>) => up(ops.toggleOutcome(...a));
export const setMission = (...a: Parameters<typeof ops.setMission>) => up(ops.setMission(...a));
export const setPlanMeta = (...a: Parameters<typeof ops.setPlanMeta>) => up(ops.setPlanMeta(...a));
export const toggleStep = (...a: Parameters<typeof ops.toggleStep>) => up(ops.toggleStep(...a));
export const dismissRescue = (...a: Parameters<typeof ops.dismissRescue>) => up(ops.dismissRescue(...a));
export const pauseGuard = (...a: Parameters<typeof ops.pauseGuard>) => up(ops.pauseGuard(...a));

// ---------- plan editing ----------
export const addException = (...a: Parameters<typeof ops.addException>) => up(ops.addException(...a));
export const removeException = (...a: Parameters<typeof ops.removeException>) => up(ops.removeException(...a));
export const resetDayToTemplate = (...a: Parameters<typeof ops.resetDayToTemplate>) => up(ops.resetDayToTemplate(...a));
export const applyRescue = (...a: Parameters<typeof ops.applyRescue>) => up(ops.applyRescue(...a));
export const applyWeekRescue = (...a: Parameters<typeof ops.applyWeekRescue>) => up(ops.applyWeekRescue(...a));
export const pinBlock = (...a: Parameters<typeof ops.pinBlock>) => up(ops.pinBlock(...a));
export const addDayBlock = (...a: Parameters<typeof ops.addDayBlock>) => up(ops.addDayBlock(...a));
export const moveDayBlock = (...a: Parameters<typeof ops.moveDayBlock>) => up(ops.moveDayBlock(...a));

/** Run an edit that may be refused (ops.OpError). Shows the refusal as a toast; returns true on success. */
export function attempt(run: () => void): boolean {
  try {
    run();
    return true;
  } catch (e) {
    if (e instanceof ops.OpError) {
      useStore.getState().toast(e.message, 'warn');
      return false;
    }
    throw e;
  }
}

// ---------- tasks ----------
export const addTask = (...a: Parameters<typeof ops.addTask>) => up(ops.addTask(...a));
export const updateTask = (...a: Parameters<typeof ops.updateTask>) => up(ops.updateTask(...a));
export const deleteTask = (...a: Parameters<typeof ops.deleteTask>) => up(ops.deleteTask(...a));

// ---------- rules ----------
export const saveRule = (...a: Parameters<typeof ops.saveRule>) => up(ops.saveRule(...a));
export const deleteRule = (...a: Parameters<typeof ops.deleteRule>) => up(ops.deleteRule(...a));

// ---------- distraction & later ----------
export const logDistraction = (...a: Parameters<typeof ops.logDistraction>) => up(ops.logDistraction(...a));
export const addLater = (...a: Parameters<typeof ops.addLater>) => up(ops.addLater(...a));
export const toggleLater = (...a: Parameters<typeof ops.toggleLater>) => up(ops.toggleLater(...a));
export const deleteLater = (...a: Parameters<typeof ops.deleteLater>) => up(ops.deleteLater(...a));

// ---------- settings / template / review ----------
export const updateSettings = (...a: Parameters<typeof ops.updateSettings>) => up(ops.updateSettings(...a));
export const setFeature = (...a: Parameters<typeof ops.setFeature>) => up(ops.setFeature(...a));
export const saveTemplate = (...a: Parameters<typeof ops.saveTemplate>) => up(ops.saveTemplate(...a));
export const saveReview = (...a: Parameters<typeof ops.saveReview>) => up(ops.saveReview(...a));

// ---------- data ----------

export function exportJson(): string {
  return JSON.stringify({ app: 'execution-os', exportedAt: new Date().toISOString(), doc: useStore.getState().doc }, null, 2);
}

/** Restore a backup: imported records win (re-stamped as newest) and propagate to every device. */
export function importJson(text: string) {
  const parsed = JSON.parse(text) as { doc?: Doc } | Doc;
  up(ops.importDoc(normalizeDoc('doc' in parsed && parsed.doc ? parsed.doc : (parsed as Doc))));
}

export const clearHistory = () => up(ops.clearHistory());
export const resetEverything = () => up(ops.resetEverything());
