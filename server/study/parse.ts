import { z, type ZodTypeAny } from 'zod';
import { ID_RE, parseTime } from '../../src/core/study/ids';
import type { Assessment, BankQuestion, CheckPack, Concept, Lab, ResourcePath, Segment, TestGrading, TestPaper } from '../../src/core/study/types';
import { MISTAKE_CLASSES } from '../../src/core/study/types';
import { frontMatter, parseYaml, VaultFileError } from './yaml';

// Parsers for every vault file Claude (or you) write. Lenient where it is safe (defaults, extra fields
// ignored, "m:ss" times, null for empty) and strict where a mistake would mislead (ids, urls, numbers).
// A file that fails throws VaultFileError with the field and the reason; the indexer records it.

const opt = <T extends ZodTypeAny>(s: T) => s.nullish().transform((v) => (v ?? undefined) as z.infer<T> | undefined);
const id = () => z.string().trim().toLowerCase().regex(ID_RE, 'use lowercase letters, digits and "-"');
const ids = () => opt(z.array(z.string().trim().toLowerCase())).transform((v) => (v ?? []).filter((x) => ID_RE.test(x)));
const text = (max = 4000) => z.coerce.string().trim().max(max);
const date = () => z.coerce.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');
const time = () => opt(z.union([z.number(), z.string()])).transform((v) => parseTime(v));
const url = () => z.string().trim().url().refine((u) => /^https?:\/\//.test(u), 'links must be http(s)');

function check<T extends ZodTypeAny>(schema: T, value: unknown, file: string): z.infer<T> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw new VaultFileError(`${file}: ${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);
}

const yamlOf = (raw: string, file: string) => {
  const v = parseYaml(raw, file);
  if (!v || typeof v !== 'object') throw new VaultFileError(`${file}: expected a YAML mapping`);
  return v;
};

// ---------- concept card ----------

const formula = z.union([z.string().transform((latex) => ({ latex })), z.object({ id: opt(z.coerce.string()), latex: text(1000), name: opt(text(200)) })]);
const conceptMeta = z.object({
  id: opt(id()),
  title: text(200).pipe(z.string().min(1, 'title is required')),
  subject: opt(id()),
  week: opt(z.coerce.number().int().min(0).max(60)),
  order: opt(z.coerce.number()),
  status: opt(z.enum(['stub', 'ready'])),
  released: opt(z.boolean()),
  examWeight: opt(z.coerce.number().min(0).max(100)),
  minutes: opt(z.coerce.number().min(1).max(600)),
  prereqs: ids(),
  confusedWith: ids(),
  testedBy: ids(),
  definition: opt(text(4000)),
  formulas: opt(z.array(formula)),
  sources: opt(z.array(z.union([z.string().transform((asset) => ({ asset })), z.object({ asset: text(200), ref: opt(text(200)) })]))),
  notation: opt(z.array(z.object({ iitj: text(200), resource: text(200), meaning: opt(text(300)) }))),
  graded: opt(id()),
  mergedInto: opt(id()),
});

export function parseConcept(raw: string, file: string, subject: string, fallbackId: string): Concept {
  const { meta, body } = frontMatter(raw, file);
  const m = check(conceptMeta, meta, file);
  const cid = m.id ?? fallbackId;
  if (!ID_RE.test(cid)) throw new VaultFileError(`${file}: the file name is not a valid concept id`);
  return {
    id: cid,
    subject: m.subject ?? subject,
    title: m.title,
    ...(m.week !== undefined ? { week: m.week } : {}),
    order: m.order ?? 9999,
    status: m.status ?? 'ready',
    released: m.released ?? false,
    examWeight: m.examWeight ?? 1,
    minutes: m.minutes ?? 30,
    prereqs: m.prereqs.filter((p) => p !== cid),
    confusedWith: m.confusedWith,
    testedBy: m.testedBy,
    ...(m.definition ? { definition: m.definition } : {}),
    formulas: (m.formulas ?? []).map((f, i) => ({ id: ('id' in f && f.id) || `f${i + 1}`, latex: f.latex, ...('name' in f && f.name ? { name: f.name } : {}) })),
    sources: (m.sources ?? []).map((s) => ({ asset: s.asset, ...('ref' in s && s.ref ? { ref: s.ref } : {}) })),
    notation: m.notation ?? [],
    ...(m.graded ? { graded: m.graded } : {}),
    ...(m.mergedInto && m.mergedInto !== cid ? { mergedInto: m.mergedInto } : {}),
    ...(body.trim() ? { body: body.trim().slice(0, 20_000) } : {}),
    file,
  };
}

// ---------- resource path ----------

const segment = z.object({
  kind: opt(z.enum(['intuition', 'formal', 'example'])),
  url: url(),
  start: time(),
  end: time(),
  pages: opt(text(40)),
  source: text(120).pipe(z.string().min(1, 'source is required')),
  university: opt(text(80)),
  course: opt(text(200)),
  lecture: opt(text(200)),
  why: opt(text(500)),
  checkedAt: opt(date()),
  dead: opt(z.boolean()),
  timestampVerified: opt(z.boolean()),
});

const toSegment = (s: z.infer<typeof segment>): Segment => ({
  kind: s.kind ?? 'formal',
  url: s.url,
  ...(s.start !== undefined ? { start: s.start } : {}),
  ...(s.end !== undefined ? { end: s.end } : {}),
  ...(s.pages ? { pages: s.pages } : {}),
  source: s.source,
  ...(s.university ? { university: s.university } : {}),
  ...(s.course ? { course: s.course } : {}),
  ...(s.lecture ? { lecture: s.lecture } : {}),
  why: s.why ?? '',
  ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}),
  ...(s.dead ? { dead: true } : {}),
  ...(s.timestampVerified === false ? { timestampVerified: false } : {}),
});

export function parsePath(raw: string, file: string, fallbackConcept: string): ResourcePath {
  const m = check(z.object({ concept: opt(id()), segments: z.array(segment).min(1, 'at least one segment').max(6), alternates: opt(z.array(segment).max(6)) }), yamlOf(raw, file), file);
  for (const s of [...m.segments, ...(m.alternates ?? [])]) if (s.start !== undefined && s.end !== undefined && s.end <= s.start) throw new VaultFileError(`${file}: a segment ends before it starts (${s.url})`);
  return { concept: m.concept ?? fallbackConcept, segments: m.segments.map(toSegment), alternates: (m.alternates ?? []).map(toSegment), file };
}

// ---------- check pack ----------

const packQuestion = z.object({
  id: z.coerce.string().trim().min(1),
  q: text(2000).pipe(z.string().min(1)),
  answer: text(2000),
  kind: opt(z.enum(['short', 'numeric', 'mcq'])),
  options: opt(z.array(text(300))),
  tolerance: opt(z.coerce.number().min(0)),
  rubric: opt(text(1000)),
  keywords: opt(z.array(text(80))),
});

export function parsePack(raw: string, file: string, fallbackConcept: string): CheckPack {
  const m = check(
    z.object({
      concept: opt(id()),
      keyPoints: z.array(z.union([z.string().transform((t) => ({ text: t })), z.object({ id: opt(z.coerce.string()), text: text(500), keywords: opt(z.array(text(80))) })])).min(1, 'at least one key point').max(12),
      misconceptions: opt(z.array(z.union([z.string().transform((t) => ({ text: t })), z.object({ id: opt(z.coerce.string()), text: text(500) })]))),
      questions: opt(z.array(packQuestion).max(20)),
      formulas: opt(z.array(text(500))),
      hints: opt(z.array(text(500))),
    }),
    yamlOf(raw, file),
    file,
  );
  const qs = m.questions ?? [];
  const seen = new Set<string>();
  for (const q of qs) {
    if (seen.has(q.id)) throw new VaultFileError(`${file}: question id "${q.id}" is used twice`);
    seen.add(q.id);
    if ((q.kind ?? 'short') === 'mcq' && !(q.options ?? []).length) throw new VaultFileError(`${file}: mcq question "${q.id}" has no options`);
    if ((q.kind ?? 'short') === 'numeric' && !Number.isFinite(Number(q.answer))) throw new VaultFileError(`${file}: numeric question "${q.id}" needs a number as its answer`);
  }
  return {
    concept: m.concept ?? fallbackConcept,
    keyPoints: m.keyPoints.map((k, i) => ({ id: ('id' in k && k.id) || `k${i + 1}`, text: k.text, ...('keywords' in k && k.keywords?.length ? { keywords: k.keywords } : {}) })),
    misconceptions: (m.misconceptions ?? []).map((x, i) => ({ id: ('id' in x && x.id) || `m${i + 1}`, text: x.text })),
    questions: qs.map((q) => ({ id: q.id, q: q.q, answer: q.answer, kind: q.kind ?? 'short', ...(q.options ? { options: q.options } : {}), ...(q.tolerance !== undefined ? { tolerance: q.tolerance } : {}), ...(q.rubric ? { rubric: q.rubric } : {}), ...(q.keywords ? { keywords: q.keywords } : {}) })),
    formulas: m.formulas ?? [],
    hints: m.hints ?? [],
    file,
  };
}

// ---------- lab ----------

export function parseLab(raw: string, file: string, dirRel: string): Lab {
  const m = check(
    z.object({ id: opt(id()), concept: id(), title: text(200).pipe(z.string().min(1)), task: opt(text(20_000)), entry: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a Python function name'), starter: opt(text(20_000)), hiddenTests: opt(text(300)), timeoutSec: opt(z.coerce.number().min(1).max(300)) }),
    yamlOf(raw, file),
    file,
  );
  const hidden = (m.hiddenTests ?? 'hidden_test.py').replace(/\\/g, '/');
  if (hidden.includes('..') || hidden.startsWith('/')) throw new VaultFileError(`${file}: hiddenTests must be a file inside the lab folder`);
  return { id: m.id ?? dirRel.split('/').pop()!, concept: m.concept, title: m.title, task: m.task ?? '', entry: m.entry, ...(m.starter ? { starter: m.starter } : {}), hiddenTests: `${dirRel}/${hidden}`, timeoutSec: m.timeoutSec ?? 20, file };
}

// ---------- question bank ----------

const KINDS = ['conceptual', 'numerical', 'derivation', 'mcq', 'programming'] as const;
const rubric = () => opt(z.array(z.object({ point: text(500), marks: z.coerce.number().min(0).max(100) })));
const bankQuestion = z.object({
  id: id(),
  subject: opt(id()),
  concepts: z.array(id()).min(1, 'link at least one concept'),
  source: opt(z.enum(['pyq', 'official', 'external', 'generated'])),
  style: opt(z.enum(['iitj'])),
  kind: opt(z.enum(KINDS)),
  q: text(8000).pipe(z.string().min(1)),
  answer: opt(text(8000)),
  rubric: rubric(),
  marks: opt(z.coerce.number().min(0).max(100)),
  transfer: opt(z.boolean()),
  entry: opt(z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  starter: opt(text(20_000)),
  tests: opt(text(300)),
});

export function parseQuestions(raw: string, file: string, subject: string, subjectRel: string): BankQuestion[] {
  const v = yamlOf(raw, file) as Record<string, unknown> | unknown[];
  const list = Array.isArray(v) ? v : Array.isArray((v as Record<string, unknown>).questions) ? ((v as Record<string, unknown>).questions as unknown[]) : [v];
  return list.map((q, i) => {
    const m = check(bankQuestion, q, `${file} #${i + 1}`);
    if (m.kind === 'programming' && (!m.entry || !m.tests)) throw new VaultFileError(`${file}: programming question "${m.id}" needs entry and tests`);
    const tests = m.tests ? `${subjectRel}/${m.tests.replace(/\\/g, '/').replace(/^\.\//, '')}` : undefined;
    if (tests?.includes('..')) throw new VaultFileError(`${file}: tests must stay inside the subject folder`);
    return {
      id: m.id,
      subject: m.subject ?? subject,
      concepts: m.concepts,
      source: m.source ?? 'generated',
      ...(m.style ? { style: m.style } : {}),
      kind: m.kind ?? 'conceptual',
      q: m.q,
      ...(m.answer ? { answer: m.answer } : {}),
      ...(m.rubric ? { rubric: m.rubric } : {}),
      marks: m.marks ?? (m.rubric ? m.rubric.reduce((a, r) => a + r.marks, 0) : 2),
      ...(m.transfer ? { transfer: true } : {}),
      ...(m.entry ? { entry: m.entry } : {}),
      ...(m.starter ? { starter: m.starter } : {}),
      ...(tests ? { tests } : {}),
      file,
    };
  });
}

// ---------- assessment ----------

export function parseAssessment(raw: string, file: string, semester: string): Assessment {
  const m = check(
    z.object({
      semester: opt(z.coerce.string()),
      studyStart: date(),
      examStart: date(),
      readyBy: opt(date()),
      testEveryDays: opt(z.coerce.number().int().min(1).max(14)),
      testMinutes: opt(z.coerce.number().int().min(15).max(240)),
      subjects: z.array(z.object({ id: id(), title: text(200), code: opt(text(40)), examWeight: opt(z.coerce.number().min(0).max(1000)) })).min(1),
      components: opt(z.array(z.object({ subject: id(), name: text(200), weight: z.coerce.number().min(0), kind: text(60), date: opt(date()) }))),
      deadlines: opt(z.array(z.object({ id: id(), subject: id(), title: text(200), kind: opt(z.enum(['assignment', 'quiz', 'exam', 'other'])), due: date(), graded: opt(z.boolean()), submitted: opt(z.boolean()), url: opt(url()) }))),
      endTerm: opt(z.object({ format: opt(z.array(text(60))), notes: opt(text(2000)) })),
    }),
    yamlOf(raw, file),
    file,
  );
  return {
    semester: m.semester ?? semester,
    studyStart: m.studyStart,
    examStart: m.examStart,
    ...(m.readyBy ? { readyBy: m.readyBy } : {}),
    testEveryDays: m.testEveryDays ?? 3,
    testMinutes: m.testMinutes ?? 75,
    subjects: m.subjects.map((s) => ({ id: s.id, title: s.title, ...(s.code ? { code: s.code } : {}), examWeight: s.examWeight ?? 1 })),
    components: (m.components ?? []).map((c) => ({ ...c, ...(c.date ? { date: c.date } : { date: undefined }) })),
    deadlines: (m.deadlines ?? []).map((d) => ({ id: d.id, subject: d.subject, title: d.title, kind: d.kind ?? 'assignment', due: d.due, graded: d.graded ?? true, ...(d.submitted ? { submitted: true } : {}), ...(d.url ? { url: d.url } : {}) })),
    ...(m.endTerm ? { endTerm: { format: m.endTerm.format ?? [], ...(m.endTerm.notes ? { notes: m.endTerm.notes } : {}) } } : {}),
  };
}

// ---------- 3-day test ----------

const testItem = z.object({
  id: z.coerce.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, 'letters, digits, "-" and "_"'),
  subject: id(),
  concepts: z.array(id()).min(1),
  bucket: opt(z.enum(['new', 'retention', 'mistake', 'transfer'])),
  style: opt(z.enum(['iitj'])),
  kind: opt(z.enum(KINDS)),
  q: text(8000).pipe(z.string().min(1)),
  marks: z.coerce.number().min(0).max(100),
  rubric: rubric(),
  answer: opt(text(8000)),
  transfer: opt(z.boolean()),
  entry: opt(z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  starter: opt(text(20_000)),
  tests: opt(text(300)),
});

export function parseTestPaper(raw: string, file: string, dirRel: string): TestPaper {
  const m = check(
    z.object({ id: opt(date()), title: opt(text(200)), createdAt: opt(date()), durationMin: opt(z.coerce.number().int().min(10).max(300)), released: opt(z.boolean()), items: z.array(testItem).min(1) }),
    yamlOf(raw, file),
    file,
  );
  const tid = m.id ?? dirRel.split('/').pop()!;
  const seen = new Set<string>();
  const items = m.items.map((it) => {
    if (seen.has(it.id)) throw new VaultFileError(`${file}: item id "${it.id}" is used twice`);
    seen.add(it.id);
    const kind = it.kind ?? 'conceptual';
    if (kind === 'programming' && (!it.entry || !it.tests)) throw new VaultFileError(`${file}: programming item "${it.id}" needs entry and tests`);
    if (kind !== 'programming' && !it.rubric?.length) throw new VaultFileError(`${file}: written item "${it.id}" needs its rubric before release`);
    const tests = it.tests ? `${dirRel}/${it.tests.replace(/\\/g, '/').replace(/^\.\//, '')}` : undefined;
    if (tests?.includes('..')) throw new VaultFileError(`${file}: tests must stay inside the test folder`);
    return { ...it, kind, bucket: it.bucket ?? 'new', ...(tests ? { tests } : {}) };
  });
  const covers = new Map<string, Set<string>>();
  for (const it of items) for (const c of it.concepts) (covers.get(it.subject) ?? covers.set(it.subject, new Set()).get(it.subject)!).add(c);
  return {
    id: tid,
    title: m.title ?? `3-day test ${tid}`,
    createdAt: m.createdAt ?? tid,
    durationMin: m.durationMin ?? 75,
    released: m.released ?? true,
    covers: [...covers].map(([subject, cs]) => ({ subject, concepts: [...cs] })),
    items: items as TestPaper['items'],
    file,
  };
}

export function parseGrading(raw: string, file: string, testId: string): TestGrading {
  const m = check(
    z.object({
      test: opt(z.coerce.string()),
      items: z.array(z.object({ id: z.coerce.string(), marks: z.coerce.number().min(0), feedback: opt(text(4000)), mistakes: opt(z.array(z.object({ concept: id(), cls: z.enum(MISTAKE_CLASSES as [string, ...string[]]), detail: opt(text(200)) }))) })),
      reviewNotes: opt(z.record(z.string(), text(4000))),
    }),
    yamlOf(raw, file),
    file,
  );
  return { test: m.test ?? testId, items: m.items as TestGrading['items'], ...(m.reviewNotes ? { reviewNotes: m.reviewNotes } : {}), file };
}
