import { blockAt, missionFor, planFor } from '../../src/core/engine';
import { isOn } from '../../src/core/features';
import * as ops from '../../src/core/ops';
import { applyOverride } from '../../src/core/override';
import { logicalDate, MIN, offsetOf } from '../../src/core/time';
import type { Doc, StudySummary } from '../../src/core/types';
import type { Deadline, Subject } from '../../src/core/study/types';
import { sameRec } from '../../src/core/sync';
import type { HubDb } from '../db';

// The bridge from Study OS into Execution OS. Study OS never waits for a block: pressing Start pushes
// what you are doing into Execution OS, which records it, turns Focus Guard on and counts it toward
// the day's study time. Every write goes through HubDb.mutate as device "study" (history + undo).

export interface EosSessionRef {
  date: string;
  blockId: string;
  sessionId: string;
  how: 'block' | 'swap' | 'live' | 'none';
}

export interface EosBridge {
  start(label: string, studySessionId: string): EosSessionRef;
  stop(ref: EosSessionRef, proof: { status: 'done' | 'partial'; note: string; link: string }): void;
  drift(minutes: number, label: string): void;
  writeSummary(s: Omit<StudySummary, 'id' | 'u' | 'r' | 'at'>): boolean;
  syncDeadlines(deadlines: Deadline[], subjects: Subject[], submitted: Set<string>): number;
  studyMinutes(date?: string): { today: number; total: number };
  today(): string;
}

const DEVICE = 'study';
export const deadlineTaskId = (id: string) => `study-dl-${id}`;

export function hubBridge(db: HubDb, clock: () => number = Date.now): EosBridge {
  const today = () => logicalDate(clock(), db.doc.settings.dayStart);
  return {
    today,
    start(label, studySessionId) {
      return db.mutate((d: Doc, now: number): EosSessionRef => {
        const ds = d.settings.dayStart;
        const date = logicalDate(now, ds);
        const off = offsetOf(now, date, ds);
        const block = blockAt(planFor(d, date), off);
        let blockId: string | undefined;
        let how: EosSessionRef['how'] = 'none';
        if (block && block.category === 'iit') {
          blockId = block.id; // inside an IIT study block: the session starts in it
          how = 'block';
        } else if (block && block.category !== 'sleep' && isOn(d.settings, 'quickOverride') && !missionFor(planFor(d, date), block)?.title.endsWith('(Study OS)')) {
          applyOverride(date, block.id, { kind: 'swap', what: label })(d, now); // "swap to Study"
          blockId = block.id;
          how = 'swap';
        } else if (block && block.category !== 'sleep') {
          blockId = block.id;
          how = 'block';
        } else if (!block) {
          // the day has no block now: add a live block from now (until the next block, at most an hour)
          const start = Math.floor(off / 5) * 5;
          const next = planFor(d, date).blocks.filter((b) => !b.missed && b.s > start).sort((a, b) => a.s - b.s)[0];
          const end = Math.min(next?.s ?? 1440, start + 60, 1440);
          if (end - start >= 5) {
            try {
              blockId = ops.addDayBlock(date, { title: label.slice(0, 120), category: 'iit', start, end, pinned: false, focus: true, source: 'user' })(d, now);
              how = 'live';
            } catch {
              blockId = undefined;
            }
          }
        }
        // During sleep (an anchor) or when no block fits, the session starts without a block.
        const bid = blockId ?? `study:${studySessionId}`;
        const sid = ops.startSession(date, { id: bid, category: 'iit' })(d, now);
        d.sessions[sid] = { ...d.sessions[sid], source: 'study', studySessionId, label };
        return { date, blockId: bid, sessionId: sid, how };
      }, DEVICE).result;
    },
    stop(ref, proof) {
      db.mutate((d: Doc, now: number) => {
        const s = d.sessions[ref.sessionId];
        if (s && s.end === undefined) d.sessions[ref.sessionId] = { ...s, end: now, u: now };
        if (ref.how === 'none') return; // nothing to attach a proof to
        const block = planFor(d, ref.date).blocks.find((b) => b.id === ref.blockId && !b.missed);
        if (!block) return;
        ops.logSession({ date: ref.date, blockId: ref.blockId, status: proof.status, note: proof.note, links: [proof.link], via: 'study', confirmed: true })(d, now);
      }, DEVICE);
    },
    drift(minutes, label) {
      db.mutate(ops.logDistraction(minutes, 'Study OS (no activity)', 'unplanned', `No Study OS activity for ${minutes} minutes during "${label}"`), DEVICE);
    },
    writeSummary(s) {
      const r = db.mutate((d: Doc, now: number) => {
        const cur = d.study.summary;
        const { at: _a, ...curBody } = (cur ?? {}) as Partial<StudySummary>;
        const next = { ...s, id: 'summary' } as StudySummary;
        if (cur && !cur.del && sameRec(curBody, { ...next, u: 0 })) return false;
        d.study.summary = { ...next, u: now, at: now };
        return true;
      }, DEVICE);
      return r.result;
    },
    syncDeadlines(deadlines, subjects, submitted) {
      const title = new Map(subjects.map((s) => [s.id, s.title]));
      return db.mutate((d: Doc, now: number) => {
        let n = 0;
        for (const dl of deadlines) {
          const id = deadlineTaskId(dl.id);
          const want = {
            title: `${title.get(dl.subject) ?? dl.subject}: ${dl.title}`.slice(0, 200),
            area: 'iit' as const,
            deadline: dl.due,
            priority: (dl.graded ? 1 : 2) as 1 | 2,
            done: !!dl.submitted || submitted.has(dl.id),
            notes: `${dl.kind}${dl.graded ? ' · graded' : ''} · from Study OS (assessment.yaml)${dl.url ? ` · ${dl.url}` : ''}`,
          };
          const cur = d.tasks[id];
          if (cur && !cur.del && cur.title === want.title && cur.deadline === want.deadline && cur.priority === want.priority && cur.done === want.done && cur.notes === want.notes) continue;
          d.tasks[id] = { ...(cur && !cur.del ? cur : { createdAt: now }), ...want, id, u: now, ...(want.done && !cur?.doneAt ? { doneAt: now } : {}) } as Doc['tasks'][string];
          n++;
        }
        return n;
      }, DEVICE).result;
    },
    studyMinutes(date) {
      const day = date ?? today();
      const now = clock();
      let t = 0;
      let all = 0;
      for (const s of Object.values(db.doc.sessions)) {
        if (s.del || (s.source !== 'study' && s.category !== 'iit')) continue;
        const m = Math.max(0, ((s.end ?? now) - s.start) / MIN);
        all += m;
        if (s.date === day) t += m;
      }
      return { today: t, total: all };
    },
  };
}
