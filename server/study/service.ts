import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { conceptState, openRepairs, repairKey } from '../../src/core/study/ladder';
import { progress as computeProgress, readyByOf } from '../../src/core/study/progress';
import { buildQueue, visualSegment } from '../../src/core/study/queue';
import { logicalDate } from '../../src/core/time';
import { ASSET_TYPES, MISTAKE_CLASSES, RUNG_LABEL, rungIndex, type AssetType, type CheckPack, type Concept, type ConceptState, type EventKind, type EventSource, type FsrsCard, type Lab, type Progress, type QueueItem, type Rung, type StudyEvent } from '../../src/core/study/types';
import type { StudySummary } from '../../src/core/types';
import type { EosBridge, EosSessionRef } from './eos';
import { ingestFolder, listAssets, pending, type IngestOptions } from './ingest';
import { loadModel, reindex, writeStubs, type IndexResult, type Model } from './indexer';
import { renderState } from './state';
import { StudyDb } from './store';
import { StudyError } from './errors';
import { noTutor, Tutor, type TutorSetup } from './tutor';
import { Exams } from './exam';
import { graphReport } from './graph';
import { writePortfolio } from './portfolio';
import { capture, Proposals } from './proposals';
import { runHidden } from './labs';
import { isVault, layout, readVaultConfig, SUBJECT_DIRS } from './vault';

// StudyService — every Study OS operation, used by the hub API, the `study` CLI (directly when the hub
// is not running) and the MCP tools. The hub is the only long-lived owner; everything else is a client.

export { StudyError };

export interface StudyServiceOptions {
  vault: string;
  clock?: () => number;
  log?: (m: string) => void;
  eos?: EosBridge; // Execution OS (absent when the CLI runs without the hub)
  driftMinutes?: number;
  tutor?: () => TutorSetup; // Quick Tutor provider + cap (read on every call, so Settings apply at once)
}

export type State = ConceptState & { card: FsrsCard | null };

interface SessionRow {
  id: string;
  kind: 'study' | 'test';
  concept: string | null;
  test_id: string | null;
  start: number;
  end: number | null;
  last_activity: number;
  drift_marked: number;
  eos_session: string | null;
  eos_date: string | null;
  eos_block: string | null;
  summary: string | null;
}

const IDLE_STOP_MIN = 90; // a session nobody touched for 90 minutes is stopped as partial

export class StudyService {
  readonly root: string;
  readonly db: StudyDb;
  readonly clock: () => number;
  readonly say: (m: string) => void; // hub log
  eos?: EosBridge;
  driftMinutes: number;
  readonly tutor: Tutor;
  readonly exams: Exams;
  readonly proposals: Proposals;
  private cache: { model: Model; events?: StudyEvent[]; states?: Map<string, State> } | null = null;

  constructor(opts: StudyServiceOptions) {
    this.root = opts.vault;
    if (!existsSync(this.root) || !isVault(this.root)) throw new StudyError(`No Study Vault at ${this.root}. Create it with: study init ${this.root}`, 409);
    this.clock = opts.clock ?? Date.now;
    this.say = opts.log ?? (() => {});
    this.eos = opts.eos;
    this.driftMinutes = opts.driftMinutes ?? 10;
    this.db = new StudyDb(layout(this.root).db);
    this.tutor = new Tutor(this, opts.tutor ?? noTutor);
    this.exams = new Exams(this);
    this.proposals = new Proposals(this);
    this.reindex();
  }

  get L() {
    return layout(this.root);
  }

  // ---------- the model (vault files, indexed) ----------

  reindex(): IndexResult & { stubs: string[]; deadlines: number } {
    const r = reindex(this.db, this.root);
    this.cache = null;
    for (const s of this.model().subjects) for (const d of SUBJECT_DIRS) mkdirSync(join(this.L.subject(s.id), d), { recursive: true });
    const stubs = writeStubs(this.root, this.model());
    const again = stubs.length ? reindex(this.db, this.root) : null;
    if (again) this.cache = null;
    const deadlines = this.syncDeadlines();
    return { ...r, changed: r.changed + (again?.changed ?? 0), errors: again?.errors ?? r.errors, stubs, deadlines };
  }

  model(): Model {
    if (!this.cache) this.cache = { model: loadModel(this.db, this.root) };
    return this.cache.model;
  }

  private invalidate() {
    if (this.cache) this.cache = { model: this.cache.model };
  }

  /** After a re-grade: evidence must be read again. */
  invalidateEvents() {
    this.invalidate();
  }

  /** The check pack of a concept, for the tutor and tests. */
  packFor(id: string): { concept: string; title: string; pack: CheckPack; hintsOnly: boolean } {
    const c = this.concept(id);
    const pack = this.model().packs.get(c.id);
    if (!pack) throw new StudyError(`No check pack for "${c.title}" yet — Claude writes it (/packs) before you reach this concept.`, 409);
    return { concept: c.id, title: c.title, pack, hintsOnly: this.hintsOnly(c) };
  }

  /** Concepts that count for coverage: every card of the semester except merged duplicates. */
  concepts(): Concept[] {
    return [...this.model().concepts.values()].filter((c) => !c.mergedInto).sort((a, b) => a.subject.localeCompare(b.subject) || (a.week ?? 999) - (b.week ?? 999) || a.order - b.order);
  }

  private concept(id: string): Concept {
    const m = this.model();
    let c = m.concepts.get(id);
    for (let i = 0; c?.mergedInto && i < 5; i++) c = m.concepts.get(c.mergedInto);
    if (!c) throw new StudyError(`Unknown concept "${id}". See: study concepts`, 404);
    return c;
  }

  today(): string {
    return this.eos?.today() ?? logicalDate(this.clock(), 4 * 60);
  }

  assessment() {
    const a = this.model().assessment;
    if (!a) throw new StudyError(`semesters/${this.L.semester}/assessment.yaml is missing or did not parse — see: study status`, 409);
    return a;
  }

  /** IITJ assets released so far decide "released": a card says so, or an asset of a later week exists. */
  released(): (c: Concept) => boolean {
    const maxWeek = new Map<string, number>();
    for (const r of this.db.sql.prepare("SELECT subject, MAX(week) AS w FROM assets WHERE subject IS NOT NULL AND week IS NOT NULL AND type IN ('slides','transcript','notes','assignment','quiz','practical') GROUP BY subject").all() as { subject: string; w: number }[]) maxWeek.set(r.subject, r.w);
    return (c) => c.released || (c.week !== undefined && (maxWeek.get(c.subject) ?? -1) >= c.week);
  }

  // ---------- evidence ----------

  /** All evidence, with Claude's re-grades applied over the Quick Tutor's verdicts. */
  events(): StudyEvent[] {
    if (!this.cache) this.model();
    if (!this.cache!.events) {
      const finals = new Map((this.db.sql.prepare('SELECT id, final FROM verdicts WHERE final IS NOT NULL').all() as { id: string; final: string }[]).map((r) => [r.id, JSON.parse(r.final) as Record<string, unknown>]));
      this.cache!.events = this.db
        .events()
        .filter((e) => {
          // a mistake the tutor saw is dropped when Claude's re-grade says the answer was right
          const v = e.kind === 'mistake' && e.source === 'tutor' && typeof e.data.verdict === 'string' ? finals.get(e.data.verdict) : undefined;
          return !(v && (v.pass === true || v.correct === true));
        })
        .map((e) => {
          const v = e.kind !== 'mistake' && typeof e.data.verdict === 'string' ? finals.get(e.data.verdict) : undefined;
          return v ? { ...e, data: { ...e.data, ...v, regraded: true } } : e;
        });
    }
    return this.cache!.events;
  }

  states(): Map<string, State> {
    if (!this.cache) this.model();
    if (this.cache!.states) return this.cache!.states;
    const m = this.model();
    const byConcept = new Map<string, StudyEvent[]>();
    const alias = (id: string) => {
      let c = m.concepts.get(id);
      for (let i = 0; c?.mergedInto && i < 5; i++) c = m.concepts.get(c.mergedInto);
      return c?.id ?? id;
    };
    for (const e of this.events()) if (e.concept) (byConcept.get(alias(e.concept)) ?? byConcept.set(alias(e.concept), []).get(alias(e.concept))!).push(e);
    const now = this.clock();
    const out = new Map<string, State>();
    for (const c of this.concepts()) {
      out.set(c.id, conceptState({ concept: c.id, events: byConcept.get(c.id) ?? [], packQuestions: m.packs.get(c.id)?.questions.length ?? 0, hasLab: m.labs.has(c.id), pathLength: m.paths.get(c.id)?.segments.length ?? 0, now }));
    }
    this.cache!.states = out;
    return out;
  }

  repairs() {
    return openRepairs(this.events()).filter((r) => this.model().concepts.has(r.concept));
  }

  log(p: { kind: EventKind; concept?: string; data?: Record<string, unknown>; source?: EventSource; at?: number; session?: string }): { seq: number; rung?: Rung } {
    const data = validateEvent(p.kind, p.data ?? {});
    const concept = p.concept ? this.concept(p.concept).id : undefined;
    if (NEEDS_CONCEPT.has(p.kind) && !concept) throw new StudyError(`"${p.kind}" needs a concept`);
    const live = this.liveSession();
    const seq = this.db.addEvent({ kind: p.kind, concept, session: p.session ?? live?.id, source: p.source ?? 'cli', data, at: p.at ?? this.clock() });
    if (live) this.touch(live.id);
    this.invalidate();
    return { seq, ...(concept ? { rung: this.states().get(concept)?.rung } : {}) };
  }

  // ---------- views ----------

  progress(): Progress {
    const a = this.assessment();
    const mins = this.eos?.studyMinutes() ?? { today: 0, total: 0 };
    const lectureKeys = new Set<string>();
    const watched = new Set<string>();
    const lectureOf = new Map<string, string>();
    for (const r of listAssets(this.db)) {
      if (!r.subject || !['slides', 'transcript'].includes(r.type)) continue;
      const k = `${r.subject}|${r.week ?? '?'}|${(/(?:lecture|lec)[\s_-]*0*(\d{1,3})/i.exec(r.title)?.[1]) ?? r.id}`;
      lectureKeys.add(k);
      lectureOf.set(r.id, k);
    }
    const submitted = this.submittedDeadlines();
    for (const e of this.events()) if (e.kind === 'iitj_lecture' && typeof e.data.asset === 'string' && lectureOf.has(e.data.asset)) watched.add(lectureOf.get(e.data.asset)!);
    const assignments = a.deadlines.filter((d) => d.kind === 'assignment' || d.kind === 'quiz');
    return computeProgress({
      today: this.today(),
      now: this.clock(),
      assessment: a,
      concepts: this.concepts(),
      states: this.states(),
      released: this.released(),
      iitj: { lectures: lectureKeys.size, lecturesWatched: watched.size, assignments: assignments.length, assignmentsSubmitted: assignments.filter((d) => d.submitted || submitted.has(d.id)).length },
      studyMinutesToday: mins.today,
      studyMinutesTotal: mins.total,
    });
  }

  /** A released 3-day test waiting to be taken. */
  testDue(): { id: string; title: string; minutes: number } | null {
    return this.model().assessment ? this.exams.due() : null;
  }

  // ---------- labs ----------

  /** Run your code against the lab's hidden tests on this PC. Your latest code is kept as my_solution.py. */
  async runLab(p: { lab?: string; concept?: string; code: string }) {
    const m = this.model();
    const lab = p.lab ? m.labsById.get(p.lab) : p.concept ? m.labs.get(this.concept(p.concept).id) : undefined;
    if (!lab) throw new StudyError(`No lab ${p.lab ?? `for ${p.concept}`} yet — Claude writes labs with /labs.`, 404);
    if (!p.code.trim()) throw new StudyError('Paste or write your code first.');
    if (p.code.length > 200_000) throw new StudyError('That code is larger than 200 KB.');
    const dir = join(this.root, lab.hiddenTests.split('/').slice(0, -1).join('/'));
    writeFileSync(join(dir, 'my_solution.py'), p.code);
    const r = await runHidden(p.code, join(this.root, lab.hiddenTests), lab.entry, lab.timeoutSec);
    this.log({ kind: 'lab', concept: lab.concept, data: { lab: lab.id, passed: r.ok, passedTests: r.passed, total: r.total, ...(r.error ? { output: r.error } : {}) }, source: 'lab' });
    return { lab: lab.id, ok: r.ok, passed: r.passed, total: r.total, tests: r.tests, ...(r.error ? { error: r.error } : {}), ms: r.ms, rung: this.states().get(lab.concept)?.rung };
  }

  queue(limit?: number): QueueItem[] {
    const m = this.model();
    const p = m.assessment ? this.progress() : null;
    return buildQueue({
      now: this.clock(),
      concepts: this.concepts(),
      states: this.states(),
      repairs: this.repairs(),
      paths: m.paths,
      subjects: m.subjects,
      progress: p?.subjects ?? [],
      testDue: this.testDue(),
      byWeight: p?.reorderedByWeight ?? false,
      limit,
    });
  }

  next(p: { limit?: number } = {}): { items: QueueItem[] } {
    return { items: this.queue(p.limit ?? 20) };
  }

  conceptList(p: { subject?: string } = {}) {
    const st = this.states();
    const rel = this.released();
    const m = this.model();
    return this.concepts()
      .filter((c) => !p.subject || c.subject === p.subject)
      .map((c) => ({ id: c.id, subject: c.subject, title: c.title, week: c.week ?? null, status: c.status, released: rel(c), rung: st.get(c.id)?.rung ?? 'none', nextStep: st.get(c.id)?.nextStep ?? 'watch', hasPath: m.paths.has(c.id), hasPack: m.packs.has(c.id), hasLab: m.labs.has(c.id) }));
  }

  conceptView(p: { id: string }) {
    const c = this.concept(p.id);
    const m = this.model();
    const st = this.states().get(c.id)!;
    const pack = m.packs.get(c.id);
    const lab = m.labs.get(c.id);
    const { file: _f, body, ...card } = c;
    return {
      concept: { ...card, ...(body ? { body } : {}) },
      state: { ...st, card: st.card ? { due: st.card.due, stability: st.card.stability, reps: st.card.reps } : null },
      path: m.paths.get(c.id) ?? null,
      pack: pack ? publicPack(pack) : null,
      lab: lab ? publicLab(lab) : null,
      hintsOnly: this.hintsOnly(c),
      repairs: this.repairs().filter((r) => r.concept === c.id),
      visual: visualSegment(m.paths.get(c.id)) ?? null,
      recent: this.events()
        .filter((e) => e.concept === c.id && e.kind !== 'activity')
        .slice(-20)
        .reverse()
        .map((e) => ({ at: e.at, kind: e.kind, source: e.source, data: e.data })),
    };
  }

  /** Part of a live graded assignment that is not submitted yet: hints only, never solutions. */
  hintsOnly(c: Concept): boolean {
    if (!c.graded) return false;
    const dl = this.model().assessment?.deadlines.find((d) => d.id === c.graded);
    if (!dl) return true; // unknown deadline: stay on the safe side
    return !(dl.submitted || this.submittedDeadlines().has(dl.id));
  }

  submittedDeadlines(): Set<string> {
    return new Set(this.events().filter((e) => e.kind === 'iitj_submit' && typeof e.data.deadline === 'string').map((e) => String(e.data.deadline)));
  }

  overview() {
    const m = this.model();
    const prog = m.assessment ? this.progress() : null;
    const items = this.queue(60);
    const live = this.liveSession();
    return {
      setup: { assessment: !!m.assessment, concepts: m.concepts.size, subjects: m.subjects.length },
      header: prog ? { daysToExam: prog.daysToExam, daysToReady: prog.daysToReady, readyBy: prog.readyBy, examStart: prog.examStart, coverage: prog.coverage, readiness: prog.readiness, pace: prog.pace, projectedReady: prog.projectedReady } : null,
      next: items.find((i) => i.kind === 'learn' || i.kind === 'repair') ?? null,
      due: { reviews: items.filter((i) => i.kind === 'review'), repairs: items.filter((i) => i.kind === 'repair'), test: items.find((i) => i.kind === 'test') ?? null },
      subjects: prog?.subjects ?? [],
      iitj: prog ? { track: prog.iitjTrack, ...prog.iitj, deadlines: (m.assessment?.deadlines ?? []).filter((d) => !(d.submitted || this.submittedDeadlines().has(d.id))).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 8) } : null,
      studyMinutesToday: prog?.studyMinutesToday ?? 0,
      live: live ? { id: live.id, concept: live.concept, since: live.start, kind: live.kind } : null,
      lastTest: this.lastTest(),
      jobs: this.jobs(),
      errors: this.db.fileErrors().length,
    };
  }

  lastTest(): { id: string; status: string } | null {
    const r = this.db.sql.prepare('SELECT id, status FROM tests ORDER BY id DESC LIMIT 1').get() as { id: string; status: string } | undefined;
    return r ?? null;
  }

  /** The last run of each headless job. */
  jobs(): { job: string; ok: boolean; ended: number; log: string | null; note: string | null }[] {
    return (this.db.sql.prepare('SELECT job, ok, ended, log, note FROM jobs WHERE seq IN (SELECT MAX(seq) FROM jobs GROUP BY job) ORDER BY job').all() as { job: string; ok: number; ended: number; log: string | null; note: string | null }[]).map((r) => ({ ...r, ok: !!r.ok }));
  }

  status() {
    const cfg = readVaultConfig(this.root);
    const count = (sql: string) => (this.db.sql.prepare(sql).get() as { n: number }).n;
    return {
      vault: this.root,
      name: cfg.name,
      semester: cfg.current,
      schemaVersion: this.db.schemaVersion,
      counts: {
        concepts: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'concept'"),
        stubs: this.concepts().filter((c) => c.status === 'stub').length,
        paths: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'path'"),
        packs: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'pack'"),
        labs: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'lab'"),
        questions: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'question'"),
        assets: count('SELECT COUNT(*) AS n FROM assets'),
        events: count('SELECT COUNT(*) AS n FROM events'),
      },
      assessment: !!this.model().assessment,
      errors: this.db.fileErrors(),
      pending: pending(this.db, this.root).total,
      jobs: this.jobs(),
      backups: this.db.backups().slice(0, 3),
    };
  }

  // ---------- ingestion ----------

  ingest(p: { folder: string; subject?: string; week?: number; type?: string; move?: boolean }) {
    const subjects = this.model().subjects;
    const opts: IngestOptions = { subject: p.subject, week: p.week, type: p.type as AssetType | undefined, move: p.move, now: this.clock() };
    if (opts.type && !ASSET_TYPES.includes(opts.type)) throw new StudyError(`Unknown type "${p.type}". Types: ${ASSET_TYPES.join(', ')}`);
    const r = this.db.tx(() => ingestFolder(this.db, this.root, p.folder, subjects, opts));
    const idx = this.reindex();
    return { ...r, added: r.added.map((a) => ({ id: a.id, subject: a.subject, week: a.week, type: a.type, needsClaude: a.needsClaude, extracted: a.extracted })), index: { changed: idx.changed, stubs: idx.stubs.length, errors: idx.errors } };
  }

  pending() {
    return pending(this.db, this.root);
  }

  assets(p: { status?: string; subject?: string } = {}) {
    return { assets: listAssets(this.db, p) };
  }

  /** /ingest marks an asset processed after decomposing it (or moves an unsorted one into a subject). */
  assetDone(p: { id: string }) {
    const r = this.db.sql.prepare("UPDATE assets SET status = 'processed' WHERE id = ?").run(p.id);
    if (!r.changes) throw new StudyError(`Unknown asset "${p.id}"`, 404);
    return { ok: true };
  }

  // ---------- IITJ track ----------

  deadlineSubmit(p: { id: string }) {
    const dl = this.assessment().deadlines.find((d) => d.id === p.id);
    if (!dl) throw new StudyError(`Unknown deadline "${p.id}" (see assessment.yaml)`, 404);
    this.log({ kind: 'iitj_submit', data: { deadline: dl.id }, source: 'app' });
    this.syncDeadlines();
    return { ok: true, deadline: dl.id };
  }

  iitjLecture(p: { asset: string; concept?: string }) {
    const a = listAssets(this.db).find((x) => x.id === p.asset);
    if (!a) throw new StudyError(`Unknown asset "${p.asset}"`, 404);
    return this.log({ kind: 'iitj_lecture', concept: p.concept, data: { asset: a.id }, source: 'app' });
  }

  syncDeadlines(): number {
    const a = this.model().assessment;
    if (!this.eos || !a?.deadlines.length) return 0;
    return this.eos.syncDeadlines(a.deadlines, a.subjects, this.submittedDeadlines());
  }

  // ---------- sessions (Start / Stop inside Execution OS) ----------

  liveSession(): SessionRow | null {
    return (this.db.sql.prepare('SELECT * FROM sessions WHERE end IS NULL ORDER BY start DESC LIMIT 1').get() as SessionRow | undefined) ?? null;
  }

  private touch(id: string) {
    this.db.sql.prepare('UPDATE sessions SET last_activity = ?, drift_marked = 0 WHERE id = ?').run(this.clock(), id);
  }

  activity() {
    const live = this.liveSession();
    if (live) this.touch(live.id);
    return { live: !!live };
  }

  start(p: { concept?: string; kind?: 'study' | 'test'; test?: string; label?: string } = {}) {
    const now = this.clock();
    const live = this.liveSession();
    if (live) this.stop({ note: 'switched to a new session' });
    const c = p.concept ? this.concept(p.concept) : null;
    const id = `ss-${now.toString(36)}${randomBytes(3).toString('hex')}`;
    const what = p.label ?? (c ? c.title : p.kind === 'test' ? `3-day test ${p.test ?? ''}`.trim() : 'Study OS');
    const label = `${p.kind === 'test' ? 'Test' : 'Studying'}: ${what} (Study OS)`;
    let ref: EosSessionRef | null = null;
    if (this.eos) ref = this.eos.start(label, id);
    const rungs = Object.fromEntries([...this.states()].map(([k, s]) => [k, s.rung]));
    this.db.sql
      .prepare('INSERT INTO sessions (id, kind, concept, test_id, start, last_activity, eos_session, eos_date, eos_block, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, p.kind ?? 'study', c?.id ?? null, p.test ?? null, now, now, ref?.sessionId ?? null, ref?.date ?? null, ref?.blockId ?? null, JSON.stringify({ label, how: ref?.how ?? null, rungs }));
    return { id, label, eos: ref, focusGuard: !!ref };
  }

  /** Stop the live session; its Execution OS proof fills itself from what happened in it. */
  stop(p: { note?: string; auto?: boolean; status?: 'done' | 'partial' } = {}) {
    const live = this.liveSession();
    if (!live) throw new StudyError('No study session is running.', 409);
    const now = this.clock();
    const report = this.sessionReport(live, now);
    this.db.sql.prepare('UPDATE sessions SET end = ? WHERE id = ?').run(now, live.id);
    const meta = JSON.parse(live.summary ?? '{}') as { label?: string; how?: EosSessionRef['how'] };
    if (this.eos && live.eos_session && live.eos_date && live.eos_block) {
      const note = live.kind === 'test' ? `3-day test ${live.test_id ?? ''}: ${p.note?.trim() || 'stopped'}`.replace('  ', ' ') : [report.line, p.note?.trim()].filter(Boolean).join(' — ');
      this.eos.stop({ date: live.eos_date, blockId: live.eos_block, sessionId: live.eos_session, how: meta.how ?? 'block' }, { status: p.status ?? (report.moved.length && !p.auto ? 'done' : 'partial'), note, link: `#study/session/${live.id}` });
    }
    this.db.sql.prepare('UPDATE sessions SET summary = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(live.summary ?? '{}'), report }), live.id);
    this.invalidate();
    return { id: live.id, ...report };
  }

  sessionReport(s: SessionRow, now = this.clock()) {
    const evs = this.events().filter((e) => e.session === s.id || (e.at >= s.start && e.at <= (s.end ?? now) && !e.session));
    const concepts = new Set(evs.filter((e) => e.concept && e.kind !== 'activity').map((e) => e.concept!));
    const quick = evs.filter((e) => e.kind === 'quick');
    const right = quick.filter((e) => e.data.correct === true).length;
    const labs = evs.filter((e) => e.kind === 'lab');
    const before = (JSON.parse(s.summary ?? '{}') as { rungs?: Record<string, Rung> }).rungs ?? {};
    const st = this.states();
    const moved = [...concepts].filter((c) => rungIndex(st.get(c)?.rung ?? 'none') > rungIndex(before[c] ?? 'none')).map((c) => ({ concept: c, from: before[c] ?? 'none', to: st.get(c)!.rung }));
    const parts = [`${concepts.size} concept${concepts.size === 1 ? '' : 's'}`];
    if (quick.length) parts.push(`${quick.length} question${quick.length === 1 ? '' : 's'} ${Math.round((right / quick.length) * 100)}%`);
    if (labs.length) parts.push(labs.some((e) => e.data.passed === true) ? 'lab passed' : 'lab not passed yet');
    if (moved.length) parts.push(`${moved.length} moved up (${moved.map((m) => `${this.model().concepts.get(m.concept)?.title ?? m.concept} → ${RUNG_LABEL[m.to]}`).join(', ')})`);
    return { minutes: Math.round(((s.end ?? now) - s.start) / 60_000), concepts: [...concepts], questions: quick.length, correct: right, labs: labs.length, moved, line: parts.join(', ') };
  }

  session(p: { id: string }) {
    const s = this.db.sql.prepare('SELECT * FROM sessions WHERE id = ?').get(p.id) as SessionRow | undefined;
    if (!s) throw new StudyError(`Unknown session "${p.id}"`, 404);
    const meta = JSON.parse(s.summary ?? '{}') as { label?: string; report?: unknown };
    return { id: s.id, kind: s.kind, concept: s.concept, start: s.start, end: s.end, label: meta.label, report: meta.report ?? this.sessionReport(s) };
  }

  /** Once a minute (hub): idle sessions mark drift once per idle stretch; very long idle stops them. */
  checkDrift(): 'none' | 'drift' | 'stopped' {
    const live = this.liveSession();
    if (!live) return 'none';
    const idle = (this.clock() - live.last_activity) / 60_000;
    if (idle >= IDLE_STOP_MIN) {
      this.stop({ note: `stopped automatically after ${IDLE_STOP_MIN} minutes without activity`, auto: true });
      return 'stopped';
    }
    if (idle >= this.driftMinutes && !live.drift_marked) {
      this.db.sql.prepare('UPDATE sessions SET drift_marked = 1 WHERE id = ?').run(live.id);
      this.eos?.drift(this.driftMinutes, (JSON.parse(live.summary ?? '{}') as { label?: string }).label ?? 'Study OS');
      return 'drift';
    }
    return 'none';
  }

  // ---------- the synced summary and STATE.md ----------

  summary(): Omit<StudySummary, 'id' | 'u' | 'r' | 'at'> | null {
    const m = this.model();
    if (!m.assessment) return null;
    const p = this.progress();
    const items = this.queue(60);
    const next = items.find((i) => i.kind === 'learn' || i.kind === 'repair');
    const live = this.liveSession();
    const failed = this.jobs().find((j) => !j.ok);
    const subjectTitle = (id: string) => m.subjects.find((s) => s.id === id)?.title ?? id;
    return {
      date: p.date,
      minutesToday: Math.floor(p.studyMinutesToday / 5) * 5,
      pace: p.pace.status,
      behindBy: p.pace.behindBy,
      ...(next && (next.kind === 'learn' || next.kind === 'repair') ? { next: { concept: next.title, subject: subjectTitle(next.subject), minutes: next.minutes, why: next.why } } : {}),
      testsDue: items.filter((i) => i.kind === 'test').length,
      reviewsDue: items.filter((i) => i.kind === 'review').length,
      repairs: items.filter((i) => i.kind === 'repair').length,
      coverage: Math.round(p.coverage * 100) / 100,
      readiness: Math.round(p.readiness * 100) / 100,
      readyBy: p.readyBy,
      projectedReady: p.projectedReady,
      examStart: p.examStart,
      ...(live ? { live: { concept: live.concept ? (m.concepts.get(live.concept)?.title ?? live.concept) : live.kind === 'test' ? '3-day test' : 'Study OS', since: live.start } } : {}),
      ...(failed ? { lastJobFailed: failed.job } : {}),
    };
  }

  pushSummary(): boolean {
    const s = this.eos ? this.summary() : null;
    return s ? this.eos!.writeSummary(s) : false;
  }

  writeState(): { file: string; text: string } {
    const text = renderState(this);
    writeFileSync(this.L.state, text);
    return { file: this.L.state, text };
  }

  // ---------- phone, portfolio, graph ----------

  capture(p: { text: string; url?: string; subject?: string; from?: string }) {
    if (!p.text?.trim() && !p.url) throw new StudyError('Write something (or share a link) to capture.');
    return capture(this, { ...p, text: p.text ?? '' });
  }

  /** What the phone keeps for offline use: the next 3 items with their packs, and the due reviews. */
  offlinePack() {
    const q = this.queue(40);
    const next = q.filter((i): i is Extract<QueueItem, { concept: string }> => (i.kind === 'learn' || i.kind === 'repair') && 'concept' in i).slice(0, 3);
    return {
      at: this.clock(),
      overview: this.overview(),
      items: next.map((i) => ({ item: i, view: this.conceptView({ id: i.concept }) })),
      reviews: q.filter((i) => i.kind === 'review').map((i) => ({ item: i, view: 'concept' in i ? { concept: { id: i.concept, title: i.title } } : null })),
    };
  }

  portfolio() {
    return writePortfolio(this);
  }

  dedupe() {
    return graphReport([...this.model().concepts.values()]);
  }

  readyBy(): string {
    return readyByOf(this.assessment());
  }

  close() {
    this.db.close();
  }
}

// ---------- evidence validation ----------

const NEEDS_CONCEPT = new Set<EventKind>(['segment_done', 'explain', 'quick', 'lab', 'review', 'test_item', 'mistake']);

function validateEvent(kind: EventKind, d: Record<string, unknown>): Record<string, unknown> {
  const bool = (k: string) => {
    if (typeof d[k] !== 'boolean') throw new StudyError(`"${kind}" needs ${k}: true or false`);
    return d[k] as boolean;
  };
  const frac = (k: string) => {
    const n = Number(d[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new StudyError(`"${kind}" needs ${k} between 0 and 1`);
    return n;
  };
  const keep = (ks: string[]) => Object.fromEntries(ks.filter((k) => d[k] !== undefined).map((k) => [k, typeof d[k] === 'string' ? String(d[k]).slice(0, 2000) : d[k]]));
  switch (kind) {
    case 'segment_done':
      return keep(['index', 'url', 'alternate', 'seconds', 'repair']);
    case 'explain':
      return { ...keep(['verdict', 'covered', 'missed', 'note']), coverage: frac('coverage'), pass: bool('pass') };
    case 'quick':
      if (typeof d.question !== 'string' || !d.question) throw new StudyError('"quick" needs question: <id>');
      return { ...keep(['question', 'verdict', 'answer', 'repair', 'note']), correct: bool('correct') };
    case 'lab': {
      const total = Number(d.total ?? 0);
      const passedTests = Number(d.passedTests ?? 0);
      return { ...keep(['lab', 'note', 'output']), passed: bool('passed'), total: Number.isFinite(total) ? total : 0, passedTests: Number.isFinite(passedTests) ? passedTests : 0 };
    }
    case 'review': {
      const g = Number(d.grade);
      if (![1, 2, 3, 4].includes(g)) throw new StudyError('"review" needs grade 1 (forgot) … 4 (easy)');
      return { ...keep(['note']), grade: g };
    }
    case 'test_item':
      return { ...keep(['test', 'item', 'kind', 'bucket', 'note']), correct: bool('correct'), score: d.score === undefined ? (d.correct ? 1 : 0) : frac('score'), timed: d.timed !== false, transfer: d.transfer === true };
    case 'mistake':
      if (!(MISTAKE_CLASSES as string[]).includes(String(d.cls))) throw new StudyError(`"mistake" needs cls: one of ${MISTAKE_CLASSES.join(', ')}`);
      return { ...keep(['detail', 'source', 'verdict', 'note']), cls: d.cls };
    case 'repair_done':
      if (typeof d.key !== 'string') throw new StudyError('"repair_done" needs key');
      return keep(['key']);
    case 'iitj_lecture':
    case 'iitj_submit':
    case 'activity':
      return keep(['asset', 'deadline', 'note']);
    default:
      throw new StudyError(`Unknown evidence kind "${kind}"`);
  }
}

export { repairKey };

// ---------- what may leave the hub before an answer ----------

/** The pack as the learner sees it: questions without answers, key points only as a count. */
export function publicPack(p: CheckPack) {
  return { concept: p.concept, keyPoints: p.keyPoints.length, questions: p.questions.map((q) => ({ id: q.id, q: q.q, kind: q.kind, ...(q.options ? { options: q.options } : {}) })), formulas: p.formulas, hints: p.hints };
}

/** The lab without its hidden tests. */
export function publicLab(l: Lab) {
  return { id: l.id, concept: l.concept, title: l.title, task: l.task, entry: l.entry, starter: l.starter ?? '', timeoutSec: l.timeoutSec };
}
