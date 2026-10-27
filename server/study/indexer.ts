import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseSyllabus, type ParsedTopic } from '../../src/core/study/syllabus';
import type { Assessment, BankQuestion, CheckPack, Concept, Lab, ResourcePath, Subject, TestGrading, TestPaper } from '../../src/core/study/types';
import { parseAssessment, parseConcept, parseGrading, parseLab, parsePack, parsePath, parseQuestions, parseTestPaper } from './parse';
import type { StudyDb } from './store';
import { layout, rel } from './vault';
import { withFrontMatter } from './yaml';

// Vault files → study.db. Only files whose content changed are parsed again; a file that does not
// parse keeps its error (shown by `study status` and on the Study home) and contributes nothing.

export interface Model {
  semester: string;
  assessment: Assessment | null;
  subjects: Subject[];
  syllabus: Map<string, ParsedTopic[]>;
  concepts: Map<string, Concept>;
  paths: Map<string, ResourcePath>;
  packs: Map<string, CheckPack>;
  labs: Map<string, Lab>; // by concept (first lab)
  labsById: Map<string, Lab>;
  questions: Map<string, BankQuestion>;
  tests: Map<string, TestPaper>;
  gradings: Map<string, TestGrading>;
}

type Kind = 'assessment' | 'syllabus' | 'concept' | 'path' | 'pack' | 'lab' | 'question' | 'test' | 'grading';

/** Which vault file is which, by its place in the folder layout. */
export function kindOf(relPath: string, semester: string): { kind: Kind; subject?: string } | null {
  const p = relPath.split('/');
  if (p[0] === 'tests' && p.length === 3) return p[2] === 'paper.yaml' ? { kind: 'test' } : p[2] === 'grading.yaml' ? { kind: 'grading' } : null;
  if (p[0] !== 'semesters' || p[1] !== semester) return null;
  if (p.length === 3 && p[2] === 'assessment.yaml') return { kind: 'assessment' };
  if (p[2] !== 'subjects' || p.length < 5) return null;
  const subject = p[3];
  const yaml = /\.ya?ml$/i.test(relPath);
  if (p.length === 5 && p[4] === 'syllabus.md') return { kind: 'syllabus', subject };
  if (p[4] === 'concepts' && p.length === 6 && p[5].endsWith('.md')) return { kind: 'concept', subject };
  if (p[4] === 'paths' && p.length === 6 && yaml) return { kind: 'path', subject };
  if (p[4] === 'packs' && p.length === 6 && yaml) return { kind: 'pack', subject };
  if (p[4] === 'labs' && p.length === 7 && p[6] === 'lab.yaml') return { kind: 'lab', subject };
  if (p[4] === 'questions' && p.length >= 6 && yaml && !p.includes('hidden')) return { kind: 'question', subject };
  return null;
}

const SKIP = new Set(['.git', '.backups', 'logs', 'node_modules', 'assets', 'extracted', 'portfolio', 'inbox', 'sessions', 'submissions', 'hidden', '.claude']);

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(join(dir, e.name), out);
    } else if (/\.(ya?ml|md)$/i.test(e.name)) out.push(join(dir, e.name));
  }
}

const sha = (t: string) => createHash('sha1').update(t).digest('hex');
const stem = (f: string) => basename(f).replace(/\.(ya?ml|md)$/i, '');

function parse(kind: Kind, raw: string, file: string, subject: string | undefined, semester: string): { kind: string; id: string; subject?: string; data: unknown }[] {
  const subjectRel = subject ? `semesters/${semester}/subjects/${subject}` : '';
  switch (kind) {
    case 'assessment':
      return [{ kind, id: semester, data: parseAssessment(raw, file, semester) }];
    case 'syllabus':
      return [{ kind, id: subject!, subject, data: parseSyllabus(raw, subject!) }];
    case 'concept': {
      const c = parseConcept(raw, file, subject!, stem(file));
      return [{ kind, id: c.id, subject: c.subject, data: c }];
    }
    case 'path': {
      const p = parsePath(raw, file, stem(file));
      return [{ kind, id: p.concept, subject, data: p }];
    }
    case 'pack': {
      const p = parsePack(raw, file, stem(file));
      return [{ kind, id: p.concept, subject, data: p }];
    }
    case 'lab': {
      const l = parseLab(raw, file, dirname(file));
      return [{ kind, id: l.id, subject, data: l }];
    }
    case 'question':
      return parseQuestions(raw, file, subject!, subjectRel).map((q) => ({ kind, id: q.id, subject: q.subject, data: q }));
    case 'test': {
      const t = parseTestPaper(raw, file, dirname(file));
      return [{ kind, id: t.id, data: t }];
    }
    case 'grading': {
      const g = parseGrading(raw, file, basename(dirname(file)));
      return [{ kind, id: g.test, data: g }];
    }
  }
}

export interface IndexResult {
  scanned: number;
  changed: number;
  removed: number;
  errors: { path: string; error: string }[];
}

export function reindex(db: StudyDb, root: string): IndexResult {
  const L = layout(root);
  const files: string[] = [];
  walk(join(root, 'semesters', L.semester), files);
  walk(L.tests, files);
  const known = db.fileHashes();
  const seen = new Set<string>();
  const res: IndexResult = { scanned: 0, changed: 0, removed: 0, errors: [] };
  db.tx(() => {
    for (const full of files) {
      const r = rel(root, full);
      const k = kindOf(r, L.semester);
      if (!k) continue;
      seen.add(r);
      res.scanned++;
      const raw = readFileSync(full, 'utf8');
      const h = sha(raw);
      if (known.get(r) === h) continue;
      res.changed++;
      db.removeItemsOfFile(r);
      try {
        const items = parse(k.kind, raw, r, k.subject, L.semester);
        for (const it of items) {
          const clash = db.sql.prepare('SELECT file FROM items WHERE kind = ? AND id = ? AND file != ?').get(it.kind, it.id, r) as { file: string } | undefined;
          if (clash && existsSync(join(root, clash.file))) throw new Error(`${r}: ${it.kind} id "${it.id}" is already used by ${clash.file}`);
          db.putItem(it.kind, it.id, it.subject, r, it.data);
        }
        db.setFile(r, h, k.kind, null);
      } catch (e) {
        db.setFile(r, h, k.kind, (e as Error).message.slice(0, 500));
      }
    }
    for (const r of known.keys()) {
      if (!seen.has(r)) {
        db.removeFile(r);
        res.removed++;
      }
    }
  });
  res.errors = db.fileErrors();
  return res;
}

export function loadModel(db: StudyDb, root: string): Model {
  const L = layout(root);
  const assessment = db.item<Assessment>('assessment', L.semester) ?? null;
  const labs = db.items<Lab>('lab');
  const byConcept = new Map<string, Lab>();
  for (const l of labs) if (!byConcept.has(l.concept)) byConcept.set(l.concept, l);
  return {
    semester: L.semester,
    assessment,
    subjects: assessment?.subjects ?? [],
    syllabus: new Map(db.sql.prepare("SELECT id, data FROM items WHERE kind = 'syllabus'").all().map((r) => [String((r as { id: string }).id), JSON.parse(String((r as { data: string }).data)) as ParsedTopic[]])),
    concepts: new Map(db.items<Concept>('concept').map((c) => [c.id, c])),
    paths: new Map(db.items<ResourcePath>('path').map((p) => [p.concept, p])),
    packs: new Map(db.items<CheckPack>('pack').map((p) => [p.concept, p])),
    labs: byConcept,
    labsById: new Map(labs.map((l) => [l.id, l])),
    questions: new Map(db.items<BankQuestion>('question').map((q) => [q.id, q])),
    tests: new Map(db.items<TestPaper>('test').map((t) => [t.id, t])),
    gradings: new Map(db.items<TestGrading>('grading').map((g) => [g.test, g])),
  };
}

/** Write a stub card for every syllabus topic that has no concept card yet. Never touches existing cards. */
export function writeStubs(root: string, model: Model): string[] {
  const L = layout(root);
  const written: string[] = [];
  const subjects = new Set(model.subjects.map((s) => s.id));
  for (const [subject, topics] of model.syllabus) {
    if (subjects.size && !subjects.has(subject)) continue;
    for (const t of topics) {
      if (model.concepts.has(t.id)) continue;
      const file = join(L.subject(subject), 'concepts', `${t.id}.md`);
      if (existsSync(file)) continue;
      mkdirSync(dirname(file), { recursive: true });
      const meta: Record<string, unknown> = { id: t.id, title: t.title, ...(t.week !== undefined ? { week: t.week } : {}), order: t.order, status: 'stub', ...(t.examWeight ? { examWeight: t.examWeight } : {}) };
      writeFileSync(file, withFrontMatter(meta, `\n<!-- Stub from syllabus.md${t.group ? ` (${t.group})` : ''}. /ingest fills this card once the IITJ material for it arrives. -->\n`));
      written.push(rel(root, file));
    }
  }
  return written;
}

/** Re-index shortly after files change (Claude writing, you editing). */
export function watchVault(root: string, onChange: () => void, delayMs = 1500): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let w: FSWatcher | null = null;
  try {
    w = watch(root, { recursive: true }, (_e, name) => {
      const n = String(name ?? '').replace(/\\/g, '/');
      if (!n || /^(\.git|\.backups|logs)\//.test(n) || n.startsWith('study.db')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, delayMs);
    });
    w.on('error', () => {});
  } catch {
    /* recursive watch unsupported: the hub still re-indexes on every ingest and once a minute */
  }
  return () => {
    if (timer) clearTimeout(timer);
    w?.close();
  };
}

export const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
