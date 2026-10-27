import { z } from 'zod';
import { MISTAKE_CLASSES, RUNG_LABEL } from '../../src/core/study/types';
import type { Register } from '../mcp/tools';
import { InputError } from '../mcp/format';
import { StudyError } from './errors';
import type { StudyService } from './service';

// Study OS tools on the existing Execution OS connector (only while the "study" flag is on). Claude on
// the phone or desktop can read the overview, the queue and test reports, capture into the inbox, log
// an attempt, and PROPOSE graph or path changes — which wait for you in the Study tab, with undo.
// Heavy work (ingest, curation, test building, grading) never runs through MCP. Raw course files never
// leave the PC: these tools return summaries only.

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const conceptId = () => z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const segment = strict({
  kind: z.enum(['intuition', 'formal', 'example']),
  url: z.string().url().max(2000).refine((u) => u.startsWith('https://'), 'https links only'),
  start: z.union([z.number().int().min(0), z.string().max(10)]).optional(),
  end: z.union([z.number().int().min(0), z.string().max(10)]).optional(),
  pages: z.string().max(40).optional(),
  source: z.string().min(1).max(120),
  university: z.string().max(80).optional(),
  course: z.string().max(200).optional(),
  lecture: z.string().max(200).optional(),
  why: z.string().min(1).max(300),
});

export function registerStudyTools(register: Register, study: () => StudyService | null) {
  // Study OS refusals read as plain answers in the chat (not "something went wrong").
  const reg: Register = (name, cfg, fn) =>
    register(name, cfg, (async (a: never, tx: Parameters<typeof fn>[1]) => {
      try {
        return await fn(a, tx);
      } catch (e) {
        if (e instanceof StudyError) throw new InputError(e.message);
        throw e;
      }
    }) as typeof fn);
  const svc = () => {
    const s = study();
    if (!s) throw new InputError('Study OS has no vault yet. On the PC run: npm run study -- init C:\\StudyOS');
    return s;
  };
  const pct = (n: number) => Math.round(n * 100);

  reg('study_overview', { title: 'Study OS overview', kind: 'read', input: strict({}), description: 'Study OS home: days to the exam and to the ready date, overall coverage and readiness, pace, the next item (concept, subject, segment length, why now), what is due today (reviews, repairs, the 3-day test), the four subject bars and IITJ deadlines. Call this first for anything about studying.' }, () => {
    const o = svc().overview();
    const h = o.header;
    return {
      summary: h ? `Exam in ${h.daysToExam} days · ready by ${h.readyBy} · coverage ${pct(h.coverage)}% · readiness ${pct(h.readiness)}% · pace ${h.pace.status}${h.pace.behindBy ? ` (behind by ${h.pace.behindBy})` : ''} · next: ${o.next?.title ?? 'nothing queued'}` : 'Study OS is set up but assessment.yaml is missing.',
      data: { header: h, next: o.next, due: { reviews: o.due.reviews.length, repairs: o.due.repairs.map((r) => r.title), test: o.due.test }, subjects: o.subjects.map((s) => ({ subject: s.title, coverage: pct(s.coverage), readiness: pct(s.readiness), concepts: s.concepts })), iitj: o.iitj, studyMinutesToday: o.studyMinutesToday, live: o.live, lastTest: o.lastTest, jobsFailed: o.jobs.filter((j) => !j.ok).map((j) => j.job) },
    };
  });

  reg('study_next', { title: 'Study queue', kind: 'read', input: strict({ limit: z.number().int().min(1).max(30).optional() }), description: 'The study queue in order: repair items (the same mistake twice), due reviews, the 3-day test when due, then concepts to learn with the step (watch / explain / quick / lab) and the resource segment. Each item says why it is next.' }, (a: { limit?: number }) => {
    const items = svc().next({ limit: a.limit ?? 10 }).items;
    return { summary: `${items.length} item(s); first: ${items[0] ? `${items[0].kind} — ${items[0].title}` : 'none'}.`, data: { items } };
  });

  reg('study_progress', { title: 'Study progress', kind: 'read', input: strict({}), description: 'Syllabus coverage, released coverage, readiness, IITJ track, pace (needed vs actual concepts per day), projected ready date and study hours, per subject. All numbers come from evidence; narrate them, never round them up.' }, () => {
    const p = svc().progress();
    return { summary: `Coverage ${pct(p.coverage)}%, readiness ${pct(p.readiness)}%, projected ready ${p.projectedReady ?? 'unknown'} (target ${p.readyBy}). These numbers come from evidence — do not change them.`, data: p as unknown as Record<string, unknown> };
  });

  reg('study_test_report', { title: '3-day test report', kind: 'read', input: strict({ testId: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), description: 'The report of a graded 3-day test (default: the latest): score per subject, concepts that moved, mistake classes, repair items added, coverage, readiness and projected ready date.' }, (a: { testId?: string }) => {
    const s = svc();
    const id = a.testId ?? s.exams.list().find((t) => t.status === 'graded')?.id;
    if (!id) throw new InputError('No 3-day test has been graded yet.');
    const r = s.exams.report({ id }).report;
    return { summary: `Test ${id}: ${pct(r.total.pct)}% (${r.total.marks}/${r.total.max}); ${r.moved.length} concept(s) moved, ${r.repairsAdded.length} repair item(s) added.`, data: { report: r, moved: r.moved.map((m) => ({ ...m, from: RUNG_LABEL[m.from], to: RUNG_LABEL[m.to] })) } };
  });

  reg('study_capture', { title: 'Capture to the Study inbox', kind: 'write', input: strict({ text: z.string().max(5000), url: z.string().url().max(2000).optional(), subject: z.string().max(40).optional() }), description: 'Save a note, a question, a doubt or a link into the Study Vault inbox; the next ingest job files it (a question for the bank, a note on a concept, a link to curate). Use the user’s words.' }, (a: { text: string; url?: string; subject?: string }) => {
    const r = svc().capture({ ...a, from: 'mcp' });
    return { summary: `Captured to ${r.file}; the next ingest will file it.`, data: r };
  });

  reg('study_log_attempt', {
    title: 'Log a study attempt (after the user confirms)',
    kind: 'write',
    input: strict({
      concept: conceptId(),
      kind: z.enum(['segment_done', 'quick', 'review', 'mistake', 'explain']),
      question: z.string().max(80).optional(),
      correct: z.boolean().optional(),
      grade: z.number().int().min(1).max(4).optional(),
      coverage: z.number().min(0).max(1).optional(),
      pass: z.boolean().optional(),
      cls: z.enum(MISTAKE_CLASSES as [string, ...string[]]).optional(),
      detail: z.string().max(80).optional(),
      userConfirmed: z.literal(true),
    }),
    description: 'Record evidence the user reports from studying away from the Study tab: a watched segment, a quick question (question id + correct), a spaced review (grade 1 forgot … 4 easy), a mistake (class + detail), or an explanation you checked against the pack (coverage 0–1 + pass). Ask "Log this?" first and set userConfirmed: true only after yes. Never invent results. The hub moves mastery from this evidence.',
  }, (a: { concept: string; kind: 'segment_done' | 'quick' | 'review' | 'mistake' | 'explain'; question?: string; correct?: boolean; grade?: number; coverage?: number; pass?: boolean; cls?: string; detail?: string }) => {
    const data: Record<string, unknown> =
      a.kind === 'quick' ? { question: a.question, correct: a.correct } : a.kind === 'review' ? { grade: a.grade } : a.kind === 'mistake' ? { cls: a.cls, detail: a.detail } : a.kind === 'explain' ? { coverage: a.coverage, pass: a.pass } : { index: 0 };
    const r = svc().log({ kind: a.kind, concept: a.concept, data, source: 'mcp' });
    return { summary: `Logged ${a.kind} for ${a.concept}${r.rung ? `; it is now ${RUNG_LABEL[r.rung]}` : ''}.`, data: r };
  });

  reg('study_propose', {
    title: 'Propose a graph or resource-path change',
    kind: 'proposal',
    input: strict({
      kind: z.enum(['path', 'graph']),
      concept: conceptId(),
      segments: z.array(segment).min(1).max(3).optional(),
      alternates: z.array(segment).max(3).optional(),
      prereqs: z.array(conceptId()).max(10).optional(),
      confusedWith: z.array(conceptId()).max(10).optional(),
      mergedInto: conceptId().nullable().optional(),
      rationale: z.string().max(500).optional(),
    }),
    description: 'Propose a better resource path (1–3 segments: visual intuition first, then formal, then a worked example; fetch every link first) or changes to a concept’s links (prerequisites, confused-with, merge a duplicate). Nothing changes until the user applies it in the Study tab, and an applied change can be undone. Show the user what you proposed.',
  }, (a: { kind: 'path' | 'graph'; concept: string; segments?: z.infer<typeof segment>[]; alternates?: z.infer<typeof segment>[]; prereqs?: string[]; confusedWith?: string[]; mergedInto?: string | null; rationale?: string }) => {
    if (a.kind === 'path' && !a.segments) throw new InputError('A path proposal needs segments.');
    if (a.kind === 'graph' && !a.prereqs && !a.confusedWith && a.mergedInto === undefined) throw new InputError('A graph proposal needs prereqs, confusedWith or mergedInto.');
    const change = a.kind === 'path' ? { concept: a.concept, segments: a.segments!, ...(a.alternates ? { alternates: a.alternates } : {}) } : { concept: a.concept, ...(a.prereqs ? { prereqs: a.prereqs } : {}), ...(a.confusedWith ? { confusedWith: a.confusedWith } : {}), ...(a.mergedInto !== undefined ? { mergedInto: a.mergedInto } : {}) };
    try {
      const p = svc().proposals.propose({ kind: a.kind, change, rationale: a.rationale, client: 'mcp' });
      return { summary: `Proposal ${p.id} is waiting in the Study tab (${p.title}). Tell the user to apply or reject it there.`, data: { proposal: { id: p.id, title: p.title, status: p.status } } };
    } catch (e) {
      throw new InputError((e as Error).message);
    }
  });
}
