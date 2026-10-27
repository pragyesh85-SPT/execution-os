import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addDays, daysBetween } from '../../src/core/study/ids';
import { blueprint, BUCKETS, ITEM_CORRECT_AT, type SubjectBlueprint } from '../../src/core/study/testmix';
import { MISTAKE_LABEL, RUNG_LABEL, rungIndex, type BankQuestion, type MistakeClass, type Rung, type TestBucket, type TestItem, type TestPaper, type TestReport } from '../../src/core/study/types';
import { StudyError } from './errors';
import { runHidden, type RunResult } from './labs';
import type { StudyService } from './service';
import { inVault } from './vault';
import { dumpYaml } from './yaml';

// The 3-day test, from blueprint to report.
//   plan      the blueprint for the next test (Claude's /build-test writes paper.yaml from it)
//   build     a fallback paper from the question bank, packs and labs (`study test build --auto`)
//   check     the paper parses, every rubric exists, every hidden test file exists and a reference
//             solution (tests/<id>/solutions/<item>.py, optional) passes its hidden tests
//   start     a timed Execution OS focus session (the whole test, or one subject)
//   submit    answers saved; programming graded at once by the hidden tests on this PC
//   finalize  after Claude's grading.yaml: evidence per item and concept, mistakes, the report
// The Quick Tutor never grades a test.

type Status = 'built' | 'started' | 'submitted' | 'graded';

type Answers = Record<string, { text?: string; image?: string; code?: string }>;

/** After the time is up, the taker's app has this long to send its answers; then the hub submits the last saved ones. */
export const GRACE_MS = 2 * 60_000;

interface TestData {
  parts: Record<string, { startedAt?: number; submittedAt?: number; deadline?: number; auto?: boolean }>; // subject id or "all"
  programming: Record<string, RunResult & { marks: number }>;
  submissions: Record<string, { kind: 'text' | 'image' | 'code'; file: string; at: number }>;
  drafts?: Record<string, Answers>; // autosaved answers per part (submitted by the hub if the app never does)
  before?: Record<string, Rung>;
  repairsBefore?: string[];
  report?: TestReport;
}

const blank = (): TestData => ({ parts: {}, programming: {}, submissions: {} });

export class Exams {
  constructor(private readonly svc: StudyService) {}

  private row(id: string): { status: Status; data: TestData } | null {
    const r = this.svc.db.sql.prepare('SELECT status, data FROM tests WHERE id = ?').get(id) as { status: Status; data: string } | undefined;
    return r ? { status: r.status, data: { ...blank(), ...(JSON.parse(r.data) as TestData) } } : null;
  }

  private save(id: string, status: Status, data: TestData, field?: 'started' | 'submitted' | 'graded') {
    const now = this.svc.clock();
    this.svc.db.sql
      .prepare(`INSERT INTO tests (id, status, data${field ? `, ${field}` : ''}) VALUES (?, ?, ?${field ? ', ?' : ''}) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data${field ? `, ${field} = excluded.${field}` : ''}`)
      .run(...([id, status, JSON.stringify(data), ...(field ? [now] : [])] as [string, string, string, ...number[]]));
  }

  paper(id: string): TestPaper {
    const p = this.svc.model().tests.get(id);
    if (!p) {
      const err = this.svc.db.fileErrors().find((e) => e.path === `tests/${id}/paper.yaml`);
      throw new StudyError(err ? `tests/${id}/paper.yaml did not parse: ${err.error}` : `No test paper for ${id} (tests/${id}/paper.yaml).`, 404);
    }
    return p;
  }

  status(id: string): Status {
    return this.row(id)?.status ?? (this.svc.model().tests.has(id) ? 'built' : 'built');
  }

  /** Taken tests, newest first. */
  list() {
    const papers = [...this.svc.model().tests.values()].sort((a, b) => b.id.localeCompare(a.id));
    return papers.map((p) => {
      const r = this.row(p.id);
      return { id: p.id, title: p.title, items: p.items.length, durationMin: p.durationMin, status: r?.status ?? 'built', pct: r?.data.report?.total.pct ?? null };
    });
  }

  /** When the previous test was taken (its submission), or null for the first one. */
  private lastTaken(): { id: string; at: number } | null {
    const r = this.svc.db.sql.prepare("SELECT id, submitted FROM tests WHERE status IN ('submitted','graded') AND submitted IS NOT NULL ORDER BY id DESC LIMIT 1").get() as { id: string; submitted: number } | undefined;
    return r ? { id: r.id, at: r.submitted } : null;
  }

  /** The date the next test is due: every testEveryDays from the last one (the first after studyStart + N). */
  nextDue(): string {
    const a = this.svc.assessment();
    const last = this.lastTaken();
    return last ? addDays(last.id, a.testEveryDays) : addDays(a.studyStart, a.testEveryDays);
  }

  /** A paper that is released and waiting to be taken (shown in the queue). */
  due(): { id: string; title: string; minutes: number } | null {
    const today = this.svc.today();
    for (const p of [...this.svc.model().tests.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!p.released || p.id > today) continue;
      const st = this.row(p.id)?.status ?? 'built';
      if (st === 'built' || st === 'started') return { id: p.id, title: p.title, minutes: p.durationMin };
    }
    return null;
  }

  /** Should /build-test write a paper now? (due today or overdue, and no paper for that date yet) */
  buildDue(): { due: boolean; id: string; reason: string } {
    const id = this.nextDue();
    const today = this.svc.today();
    if (this.svc.model().tests.has(id)) return { due: false, id, reason: 'paper already written' };
    if (id > today) return { due: false, id, reason: `next test on ${id}` };
    if (!this.plan().subjects.length) return { due: false, id, reason: 'nothing studied yet' };
    return { due: true, id: daysBetween(id, today) > 0 ? today : id, reason: 'due' };
  }

  plan(p: { written?: number; programming?: number } = {}) {
    const a = this.svc.assessment();
    const last = this.lastTaken();
    const bp = blueprint({ subjects: a.subjects, concepts: this.svc.concepts(), states: this.svc.states(), events: this.svc.events(), lastTestAt: last?.at ?? null, writtenPerSubject: p.written, programmingPerSubject: p.programming });
    const m = this.svc.model();
    return {
      id: this.nextDue(),
      durationMin: a.testMinutes,
      since: last?.id ?? null,
      mix: { new: '40%', retention: '25%', mistake: '20%', transfer: '15%' },
      subjects: bp.map((b) => ({
        ...b,
        title: m.subjects.find((s) => s.id === b.subject)?.title ?? b.subject,
        bank: [...m.questions.values()].filter((q) => q.subject === b.subject).map((q) => ({ id: q.id, kind: q.kind, concepts: q.concepts, style: q.style ?? null, transfer: !!q.transfer })),
        labs: [...m.labs.values()].filter((l) => m.concepts.get(l.concept)?.subject === b.subject).map((l) => ({ id: l.id, concept: l.concept })),
      })),
    };
  }

  // ---------- fallback builder ----------

  build(p: { id?: string } = {}) {
    const plan = this.plan();
    if (!plan.subjects.length) throw new StudyError('Nothing has been studied yet, so there is nothing to test.', 409);
    const id = p.id ?? (this.svc.today() > plan.id ? this.svc.today() : plan.id);
    if (this.svc.model().tests.has(id)) throw new StudyError(`tests/${id}/paper.yaml already exists.`, 409);
    const dir = join(this.svc.root, 'tests', id);
    mkdirSync(join(dir, 'hidden'), { recursive: true });
    const m = this.svc.model();
    const items: Record<string, unknown>[] = [];
    for (const b of plan.subjects) items.push(...this.pickWritten(b, m.questions), ...this.pickProgramming(b, dir));
    if (!items.length) throw new StudyError('The bank, packs and labs have nothing for the studied concepts yet — run /packs and /labs first.', 409);
    const paper = { id, title: `3-day test ${id}`, createdAt: this.svc.today(), durationMin: plan.durationMin, released: true, items };
    writeFileSync(join(dir, 'paper.yaml'), `# Built by \`study test build --auto\` (fallback). /build-test normally writes this file.\n${dumpYaml(paper)}`);
    this.svc.reindex();
    return { id, items: items.length, file: `tests/${id}/paper.yaml` };
  }

  private pickWritten(b: SubjectBlueprint & { iitjStyle: number }, bank: Map<string, BankQuestion>): Record<string, unknown>[] {
    const used = new Set<string>();
    const out: Record<string, unknown>[] = [];
    const m = this.svc.model();
    let iitj = 0;
    for (const bucket of BUCKETS) {
      for (let k = 0; k < b.counts[bucket]; k++) {
        const pool = b.concepts[bucket];
        const cands = [...bank.values()].filter((q) => q.subject === b.subject && q.kind !== 'programming' && !used.has(q.id) && q.concepts.some((c) => pool.includes(c)) && (bucket !== 'transfer' || q.transfer || q.concepts.length > 1));
        cands.sort((x, y) => Number(y.style === 'iitj' && iitj < b.iitjStyle) - Number(x.style === 'iitj' && iitj < b.iitjStyle));
        const q = cands[0];
        if (q) {
          used.add(q.id);
          if (q.style === 'iitj') iitj++;
          out.push({ id: `${b.subject}-${out.length + 1}`, subject: b.subject, concepts: q.concepts, bucket, ...(q.style ? { style: q.style } : {}), kind: q.kind, q: q.q, marks: q.marks, rubric: q.rubric ?? [{ point: `Matches: ${q.answer ?? 'the model answer'}`, marks: q.marks }], ...(q.answer ? { answer: q.answer } : {}), ...(q.transfer || bucket === 'transfer' ? { transfer: true } : {}) });
          continue;
        }
        // no bank question: one from a check pack (short / numeric), worth 2 marks
        const concept = pool.find((c) => m.packs.get(c)?.questions.length && !used.has(`pack:${c}:${k}`));
        const pq = concept ? m.packs.get(concept)!.questions[k % m.packs.get(concept)!.questions.length] : undefined;
        if (concept && pq) {
          used.add(`pack:${concept}:${k}`);
          out.push({ id: `${b.subject}-${out.length + 1}`, subject: b.subject, concepts: [concept], bucket, kind: pq.kind === 'numeric' ? 'numerical' : 'conceptual', q: pq.q, marks: 2, rubric: [{ point: `Matches the expected answer: ${pq.answer}`, marks: 2 }], answer: pq.answer, ...(bucket === 'transfer' ? { transfer: true } : {}) });
        }
      }
    }
    return out;
  }

  private pickProgramming(b: SubjectBlueprint, dir: string): Record<string, unknown>[] {
    const m = this.svc.model();
    const studiedIds = new Set(BUCKETS.flatMap((x) => b.concepts[x]));
    const out: Record<string, unknown>[] = [];
    const bankQs = [...m.questions.values()].filter((q) => q.subject === b.subject && q.kind === 'programming' && q.tests && q.concepts.some((c) => studiedIds.has(c)));
    const labs = [...m.labs.values()].filter((l) => studiedIds.has(l.concept));
    for (let k = 0; k < b.programming; k++) {
      const itemId = `${b.subject}-p${k + 1}`;
      const q = bankQs[k];
      const lab = q ? undefined : labs[k - bankQs.length];
      const src = q ? q.tests! : lab?.hiddenTests;
      if (!src || !existsSync(inVault(this.svc.root, src))) continue;
      copyFileSync(inVault(this.svc.root, src), join(dir, 'hidden', `${itemId}_test.py`));
      if (q) out.push({ id: itemId, subject: b.subject, concepts: q.concepts, bucket: 'transfer', kind: 'programming', q: q.q, entry: q.entry, ...(q.starter ? { starter: q.starter } : {}), tests: `hidden/${itemId}_test.py`, marks: q.marks });
      else if (lab) out.push({ id: itemId, subject: b.subject, concepts: [lab.concept], bucket: 'retention', kind: 'programming', q: `${lab.title}. ${lab.task}`.trim(), entry: lab.entry, ...(lab.starter ? { starter: lab.starter } : {}), tests: `hidden/${itemId}_test.py`, marks: 5 });
    }
    return out;
  }

  // ---------- quality gate ----------

  async check(p: { id: string }) {
    const paper = this.paper(p.id);
    const problems: string[] = [];
    const known = this.svc.model().concepts;
    const reference: { item: string; passed: number; total: number }[] = [];
    for (const it of paper.items) {
      for (const c of it.concepts) if (!known.has(c)) problems.push(`${it.id}: unknown concept ${c}`);
      if (it.kind !== 'programming') continue;
      const tests = inVault(this.svc.root, it.tests!);
      if (!existsSync(tests)) {
        problems.push(`${it.id}: hidden tests missing (${it.tests})`);
        continue;
      }
      const sol = join(this.svc.root, 'tests', paper.id, 'solutions', `${it.id}.py`);
      if (existsSync(sol)) {
        const r = await runHidden(readFileSync(sol, 'utf8'), tests, it.entry!, 30);
        reference.push({ item: it.id, passed: r.passed, total: r.total });
        if (!r.ok) problems.push(`${it.id}: the reference solution fails its hidden tests (${r.passed}/${r.total}${r.error ? `, ${r.error}` : ''})`);
      }
    }
    const marks = paper.items.reduce((a, i) => a + i.marks, 0);
    const subjects = [...new Set(paper.items.map((i) => i.subject))];
    const missingProgramming = subjects.filter((s) => !paper.items.some((i) => i.subject === s && i.kind === 'programming'));
    if (missingProgramming.length) problems.push(`no programming part for: ${missingProgramming.join(', ')}`);
    return { ok: problems.length === 0, problems, items: paper.items.length, marks, subjects, reference };
  }

  // ---------- taking the test ----------

  /** What the taker may see: no answers, no rubric marks breakdown, never the hidden tests. */
  publicPaper(paper: TestPaper, subject?: string) {
    const items = paper.items.filter((i) => !subject || i.subject === subject);
    const all = paper.items.reduce((a, i) => a + i.marks, 0) || 1;
    const marks = items.reduce((a, i) => a + i.marks, 0);
    return {
      id: paper.id,
      title: paper.title,
      durationMin: Math.max(10, Math.round((paper.durationMin * marks) / all)),
      subject: subject ?? null,
      items: items.map((i) => ({ id: i.id, subject: i.subject, kind: i.kind, q: i.q, marks: i.marks, ...(i.style ? { style: i.style } : {}), ...(i.kind === 'programming' ? { entry: i.entry, starter: i.starter ?? '' } : {}) })),
    };
  }

  start(p: { id: string; subject?: string }) {
    const paper = this.paper(p.id);
    if (!paper.released) throw new StudyError('This test is not released yet.', 409);
    if (p.subject && !paper.items.some((i) => i.subject === p.subject)) throw new StudyError(`The test has no part for ${p.subject}.`, 404);
    const r = this.row(p.id) ?? { status: 'built' as Status, data: blank() };
    if (r.status === 'submitted' || r.status === 'graded') throw new StudyError('This test was already submitted.', 409);
    const part = p.subject ?? 'all';
    if (r.data.parts[part]?.submittedAt) throw new StudyError('That part was already submitted.', 409);
    const startedAt = r.data.parts[part]?.startedAt ?? this.svc.clock();
    const pub = this.publicPaper(paper, p.subject);
    // the clock never restarts: re-opening the test keeps the original deadline
    r.data.parts[part] = { ...(r.data.parts[part] ?? {}), startedAt, deadline: r.data.parts[part]?.deadline ?? startedAt + pub.durationMin * 60_000 };
    if (r.data.parts[part].deadline! + GRACE_MS < this.svc.clock()) throw new StudyError('The time for this test is over; your saved answers were submitted.', 409);
    r.data.before ??= Object.fromEntries([...this.svc.states()].map(([k, s]) => [k, s.rung]));
    r.data.repairsBefore ??= this.svc.repairs().map((x) => x.key);
    this.save(p.id, 'started', r.data, r.status === 'built' ? 'started' : undefined);
    const live = this.svc.liveSession();
    const session = live?.kind === 'test' && live.test_id === p.id ? { id: live.id, focusGuard: !!live.eos_session } : this.svc.start({ kind: 'test', test: p.id, label: `3-day test ${p.id}${p.subject ? ` · ${p.subject}` : ''}` });
    return { session: session.id, focusGuard: session.focusGuard, paper: pub, deadline: r.data.parts[part].deadline!, now: this.svc.clock(), draft: r.data.drafts?.[part] ?? {} };
  }

  /** Autosave while the test runs (the app calls this every ~20 s and before it closes). */
  saveDraft(p: { id: string; subject?: string; answers: Answers }) {
    const r = this.row(p.id);
    const part = p.subject ?? 'all';
    if (!r || r.status !== 'started' || !r.data.parts[part]?.startedAt) throw new StudyError('Start the test first.', 409);
    if (r.data.parts[part].submittedAt) throw new StudyError('That part was already submitted.', 409);
    if (this.svc.clock() > (r.data.parts[part].deadline ?? Infinity) + GRACE_MS) throw new StudyError('The time is up.', 409);
    r.data.drafts = { ...(r.data.drafts ?? {}), [part]: p.answers };
    this.save(p.id, 'started', r.data);
    return { ok: true, savedAt: this.svc.clock() };
  }

  /** Once a minute (hub): a part whose time ran out (plus grace) is submitted from its last saved answers. */
  async autoSubmitDue(): Promise<string[]> {
    const done: string[] = [];
    const now = this.svc.clock();
    for (const row of this.svc.db.sql.prepare("SELECT id FROM tests WHERE status = 'started'").all() as { id: string }[]) {
      const r = this.row(row.id);
      if (!r) continue;
      for (const [part, info] of Object.entries(r.data.parts)) {
        if (info.submittedAt || !info.deadline || now <= info.deadline + GRACE_MS) continue;
        await this.submit({ id: row.id, ...(part === 'all' ? {} : { subject: part }), answers: r.data.drafts?.[part] ?? {}, auto: true });
        done.push(`${row.id}:${part}`);
      }
    }
    return done;
  }

  async submit(p: { id: string; subject?: string; answers: Answers; auto?: boolean }) {
    const paper = this.paper(p.id);
    const r = this.row(p.id) ?? { status: 'built' as Status, data: blank() };
    if (r.status === 'submitted' || r.status === 'graded') throw new StudyError('This test was already submitted.', 409);
    const info = r.data.parts[p.subject ?? 'all'];
    if (info?.submittedAt) throw new StudyError('That part was already submitted.', 409);
    if (!p.auto && info?.deadline && this.svc.clock() > info.deadline + GRACE_MS) throw new StudyError('The time is up — your last saved answers are being submitted.', 409);
    const items = paper.items.filter((i) => !p.subject || i.subject === p.subject);
    const dir = join(this.svc.root, 'tests', paper.id, 'submissions');
    mkdirSync(dir, { recursive: true });
    const now = this.svc.clock();
    const programming: { id: string; passed: number; total: number; marks: number; of: number; tests: { name: string; ok: boolean; error?: string }[]; error?: string }[] = [];
    for (const it of items) {
      const a = p.answers[it.id];
      if (!a) continue;
      if (it.kind === 'programming') {
        const code = String(a.code ?? a.text ?? '');
        writeFileSync(join(dir, `${it.id}.py`), code);
        r.data.submissions[it.id] = { kind: 'code', file: `tests/${paper.id}/submissions/${it.id}.py`, at: now };
        const res = await runHidden(code, inVault(this.svc.root, it.tests!), it.entry!, 30);
        const marks = res.total ? Math.round(((it.marks * res.passed) / res.total) * 100) / 100 : 0;
        r.data.programming[it.id] = { ...res, marks };
        programming.push({ id: it.id, passed: res.passed, total: res.total, marks, of: it.marks, tests: res.tests.map((t) => ({ name: t.name, ok: t.ok })), ...(res.error ? { error: res.error } : {}) });
      } else if (a.image) {
        const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(a.image);
        if (!m) throw new StudyError(`${it.id}: the photo must be a PNG, JPEG or WebP data URL.`);
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        writeFileSync(join(dir, `${it.id}.${ext}`), Buffer.from(m[2], 'base64'));
        r.data.submissions[it.id] = { kind: 'image', file: `tests/${paper.id}/submissions/${it.id}.${ext}`, at: now };
        if (a.text?.trim()) writeFileSync(join(dir, `${it.id}.md`), a.text.trim());
      } else {
        writeFileSync(join(dir, `${it.id}.md`), String(a.text ?? '').trim());
        r.data.submissions[it.id] = { kind: 'text', file: `tests/${paper.id}/submissions/${it.id}.md`, at: now };
      }
    }
    const part = p.subject ?? 'all';
    r.data.parts[part] = { ...(r.data.parts[part] ?? {}), submittedAt: now, ...(p.auto ? { auto: true } : {}) };
    const subjects = [...new Set(paper.items.map((i) => i.subject))];
    const complete = !!r.data.parts.all?.submittedAt || subjects.every((s) => r.data.parts[s]?.submittedAt);
    this.save(paper.id, complete ? 'submitted' : 'started', r.data, complete ? 'submitted' : undefined);
    const live = this.svc.liveSession();
    if (live?.kind === 'test' && live.test_id === paper.id) this.svc.stop({ note: `${complete ? 'submitted' : `${part} part submitted`}`, status: 'done' });
    const written = items.filter((i) => i.kind !== 'programming').length;
    return { complete, programming, writtenPending: written, message: complete ? `Submitted. Programming is scored; the ${paper.items.filter((i) => i.kind !== 'programming').length} written answer(s) are graded by Claude (/grade).` : `${part} part saved. The other parts are still open.` };
  }

  /** Tests submitted and waiting for Claude's grading (the /grade job's gate). */
  awaitingGrade(): string[] {
    return (this.svc.db.sql.prepare("SELECT id FROM tests WHERE status = 'submitted' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  }

  // ---------- grading and the report ----------

  finalize(p: { id: string }): TestReport {
    const paper = this.paper(p.id);
    const r = this.row(p.id);
    if (!r || (r.status !== 'submitted' && r.status !== 'graded')) throw new StudyError('Submit the test before finalizing it.', 409);
    if (r.status === 'graded' && r.data.report) return r.data.report;
    const grading = this.svc.model().gradings.get(paper.id);
    const written = paper.items.filter((i) => i.kind !== 'programming');
    const graded = new Map((grading?.items ?? []).map((g) => [g.id, g]));
    const missing = written.filter((i) => !graded.has(i.id) && r.data.submissions[i.id]);
    if (missing.length) throw new StudyError(`tests/${paper.id}/grading.yaml has no marks for: ${missing.map((i) => i.id).join(', ')}`, 409);
    const at = r.data.parts.all?.submittedAt || Math.max(0, ...Object.values(r.data.parts).map((x) => x.submittedAt ?? 0)) || this.svc.clock();
    const scored: { item: TestItem; marks: number }[] = [];
    for (const it of paper.items) {
      let marks = 0;
      if (it.kind === 'programming') marks = r.data.programming[it.id]?.marks ?? 0;
      else marks = Math.min(it.marks, graded.get(it.id)?.marks ?? 0);
      scored.push({ item: it, marks });
      const score = it.marks ? marks / it.marks : 0;
      for (const c of it.concepts) {
        this.svc.log({ kind: 'test_item', concept: c, data: { test: paper.id, item: it.id, kind: it.kind, bucket: it.bucket, correct: score >= ITEM_CORRECT_AT, score: Math.round(score * 100) / 100, timed: true, transfer: !!it.transfer || it.bucket === 'transfer' }, source: 'test', at });
      }
      for (const mk of graded.get(it.id)?.mistakes ?? []) this.svc.log({ kind: 'mistake', concept: mk.concept, data: { cls: mk.cls, ...(mk.detail ? { detail: mk.detail } : {}), source: `test ${paper.id}` }, source: 'claude', at });
    }
    const total = scored.reduce((a, s) => a + s.marks, 0);
    const max = scored.reduce((a, s) => a + s.item.marks, 0);
    const bySubject = new Map<string, { marks: number; max: number }>();
    for (const s of scored) {
      const x = bySubject.get(s.item.subject) ?? { marks: 0, max: 0 };
      x.marks += s.marks;
      x.max += s.item.marks;
      bySubject.set(s.item.subject, x);
    }
    const st = this.svc.states();
    const before = r.data.before ?? {};
    const touched = new Set(paper.items.flatMap((i) => i.concepts));
    const moved = [...touched].map((c) => ({ concept: c, from: before[c] ?? 'none', to: st.get(c)?.rung ?? 'none' })).filter((x) => x.from !== x.to);
    const cls = new Map<MistakeClass, number>();
    for (const g of grading?.items ?? []) for (const mk of g.mistakes ?? []) cls.set(mk.cls, (cls.get(mk.cls) ?? 0) + 1);
    const repairsAdded = this.svc.repairs().map((x) => x.key).filter((k) => !(r.data.repairsBefore ?? []).includes(k));
    const prog = this.svc.progress();
    const report: TestReport = {
      test: paper.id,
      at: this.svc.clock(),
      total: { marks: round(total), max, pct: max ? total / max : 0 },
      subjects: [...bySubject].map(([subject, x]) => ({ subject, marks: round(x.marks), max: x.max, pct: x.max ? x.marks / x.max : 0 })),
      moved,
      mistakes: [...cls].map(([c, count]) => ({ cls: c, count })).sort((a, b) => b.count - a.count),
      repairsAdded,
      coverage: prog.coverage,
      readiness: prog.readiness,
      projectedReady: prog.projectedReady,
    };
    r.data.report = report;
    this.save(paper.id, 'graded', r.data, 'graded');
    writeFileSync(join(this.svc.root, 'tests', paper.id, 'report.md'), this.reportMarkdown(paper, report, scored, grading?.reviewNotes ?? {}, r.data));
    return report;
  }

  report(p: { id: string }) {
    const r = this.row(p.id);
    if (!r?.data.report) throw new StudyError(`Test ${p.id} has no report yet (status ${r?.status ?? 'not taken'}).`, 404);
    const file = join(this.svc.root, 'tests', p.id, 'report.md');
    return { report: r.data.report, markdown: existsSync(file) ? readFileSync(file, 'utf8') : null };
  }

  private reportMarkdown(paper: TestPaper, rep: TestReport, scored: { item: TestItem; marks: number }[], notes: Record<string, string>, data: TestData): string {
    const pct = (n: number) => `${Math.round(n * 100)}%`;
    const title = (c: string) => this.svc.model().concepts.get(c)?.title ?? c;
    const grading = this.svc.model().gradings.get(paper.id);
    const fb = new Map((grading?.items ?? []).map((g) => [g.id, g.feedback ?? '']));
    const lines = [
      `# ${paper.title} — report`,
      '',
      `**${round(rep.total.marks)} / ${rep.total.max} (${pct(rep.total.pct)})** · coverage ${pct(rep.coverage)} · readiness ${pct(rep.readiness)} · projected ready ${rep.projectedReady ?? 'unknown'}`,
      '',
      '## Per subject',
      '',
      '| Subject | Marks | % |',
      '| --- | --- | --- |',
      ...rep.subjects.map((s) => `| ${s.subject} | ${round(s.marks)} / ${s.max} | ${pct(s.pct)} |`),
      '',
      '## Items',
      '',
      ...scored.map(({ item, marks }) => {
        const pr = data.programming[item.id];
        const extra = item.kind === 'programming' ? ` · hidden tests ${pr?.passed ?? 0}/${pr?.total ?? 0}${notes[item.id] ? ` · review: ${notes[item.id]}` : ''}` : fb.get(item.id) ? ` · ${fb.get(item.id)}` : '';
        return `- **${item.id}** (${item.subject}, ${item.bucket}${item.style ? ', IITJ style' : ''}, ${item.kind}) ${round(marks)}/${item.marks}${extra}`;
      }),
      '',
      '## Concepts that moved',
      '',
      ...(rep.moved.length ? rep.moved.map((m) => `- ${title(m.concept)}: ${RUNG_LABEL[m.from]} → ${RUNG_LABEL[m.to]}${rungIndex(m.to) < rungIndex(m.from) ? ' (down)' : ''}`) : ['- none']),
      '',
      '## Mistakes',
      '',
      ...(rep.mistakes.length ? rep.mistakes.map((m) => `- ${MISTAKE_LABEL[m.cls]}: ${m.count}`) : ['- none recorded']),
      '',
      '## Repair items added',
      '',
      ...(rep.repairsAdded.length ? rep.repairsAdded.map((k) => `- ${k.replace(/\|/g, ' · ')}`) : ['- none']),
      '',
    ];
    return lines.join('\n');
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
export type { TestBucket };
