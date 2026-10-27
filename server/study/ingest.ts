import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { slug } from '../../src/core/study/ids';
import { classifyAsset, detectSubject, parseSyllabus } from '../../src/core/study/syllabus';
import { ASSET_TYPES, type AssetType, type Subject } from '../../src/core/study/types';
import { extractFile } from './extract';
import type { StudyDb } from './store';
import { layout, rel } from './vault';
import { withFrontMatter } from './yaml';

// The engine half of /ingest: copy every new file into the right subject's assets/ (originals are
// never edited), classify it, extract what can be read without a model, and record it. Claude then
// reads extracted/ (and the originals flagged needsClaude) to decompose concepts. Safe to re-run:
// files are recognised by their content hash.

export interface IngestOptions {
  subject?: string;
  week?: number;
  type?: AssetType;
  move?: boolean; // delete the source after copying (used for inbox/)
  now?: number;
}

export interface AssetRow {
  id: string;
  subject: string | null;
  week: number | null;
  type: AssetType;
  title: string;
  original: string | null;
  path: string;
  extracted: string | null;
  sha: string;
  needsClaude: boolean;
  status: 'new' | 'processed' | 'unsorted';
  at: number;
}

export interface IngestResult {
  added: AssetRow[];
  duplicates: string[];
  unsorted: string[]; // subject unknown: parked in inbox/unsorted for Claude to file
  skipped: { file: string; reason: string }[];
  syllabusWritten: string[];
}

const MAX_BYTES = 300 * 1024 * 1024;
const IGNORE = /^(\.|~\$|thumbs\.db$|desktop\.ini$)/i;

function listFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.test(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'unsorted' && e.name !== 'done') listFiles(full, out);
    } else out.push(full);
  }
  return out;
}

export function rowOf(r: Record<string, unknown>): AssetRow {
  return {
    id: String(r.id),
    subject: r.subject ? String(r.subject) : null,
    week: r.week === null || r.week === undefined ? null : Number(r.week),
    type: r.type as AssetType,
    title: String(r.title),
    original: r.original ? String(r.original) : null,
    path: String(r.path),
    extracted: r.extracted ? String(r.extracted) : null,
    sha: String(r.sha),
    needsClaude: !!r.needs_claude,
    status: r.status as AssetRow['status'],
    at: Number(r.at),
  };
}

export function listAssets(db: StudyDb, filter: { status?: string; subject?: string } = {}): AssetRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (filter.status) (where.push('status = ?'), args.push(filter.status));
  if (filter.subject) (where.push('subject = ?'), args.push(filter.subject));
  return (db.sql.prepare(`SELECT * FROM assets${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY subject, week, id`).all(...args) as Record<string, unknown>[]).map(rowOf);
}

export function ingestFolder(db: StudyDb, root: string, source: string, subjects: Subject[], opts: IngestOptions = {}): IngestResult {
  const L = layout(root);
  const src = resolve(source);
  if (!existsSync(src)) throw new Error(`Folder not found: ${src}`);
  const files = statSync(src).isDirectory() ? listFiles(src) : [src];
  const base = statSync(src).isDirectory() ? src : resolve(src, '..');
  const res: IngestResult = { added: [], duplicates: [], unsorted: [], skipped: [], syllabusWritten: [] };
  const now = opts.now ?? Date.now();
  if (opts.subject && !subjects.some((s) => s.id === opts.subject)) throw new Error(`Unknown subject "${opts.subject}". Subjects: ${subjects.map((s) => s.id).join(', ') || '(none — fill assessment.yaml first)'}`);
  if (opts.type && !ASSET_TYPES.includes(opts.type)) throw new Error(`Unknown type "${opts.type}". Types: ${ASSET_TYPES.join(', ')}`);

  for (const file of files) {
    const relSrc = relative(base, file);
    if (/(^|[\\/])[^\\/]*-capture\.md$/.test(file)) continue; // phone captures are notes for Claude, not assets
    const size = statSync(file).size;
    if (!size) {
      res.skipped.push({ file: relSrc, reason: 'empty file' });
      continue;
    }
    if (size > MAX_BYTES) {
      res.skipped.push({ file: relSrc, reason: 'larger than 300 MB' });
      continue;
    }
    const buf = readFileSync(file);
    const sha = createHash('sha256').update(buf).digest('hex');
    const dup = db.sql.prepare('SELECT id FROM assets WHERE sha = ?').get(sha) as { id: string } | undefined;
    if (dup) {
      res.duplicates.push(`${relSrc} (= ${dup.id})`);
      if (opts.move) rmSync(file, { force: true });
      continue;
    }
    const c = classifyAsset(relSrc);
    const type = opts.type ?? c.type;
    const week = opts.week ?? c.week;
    const subject = opts.subject ?? detectSubject(relSrc, subjects);
    const ext = extname(file).toLowerCase();
    const stemSlug = slug(basename(file, extname(file))) || 'file';
    let id = [subject ?? 'unsorted', week !== undefined ? `w${week}` : '', stemSlug].filter(Boolean).join('-').slice(0, 72).replace(/-+$/, '');
    for (let n = 2; db.sql.prepare('SELECT 1 FROM assets WHERE id = ?').get(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;

    let dest: string;
    let extractedRel: string | null = null;
    let status: AssetRow['status'] = 'new';
    const x = extractFile(file);
    if (subject) {
      dest = join(L.subject(subject), 'assets', `${id}${ext}`);
      mkdirSync(join(L.subject(subject), 'assets'), { recursive: true });
      copyFileSync(file, dest);
      const exFile = join(L.subject(subject), 'extracted', `${id}.md`);
      mkdirSync(join(L.subject(subject), 'extracted'), { recursive: true });
      const meta = { asset: id, subject, type, ...(week !== undefined ? { week } : {}), ...(c.lecture !== undefined ? { lecture: c.lecture } : {}), original: basename(file), source: rel(root, dest), ...(x.pages ? { pages: x.pages } : {}), extractedBy: x.method, needsClaude: x.needsClaude };
      writeFileSync(exFile, withFrontMatter(meta, x.text ? `\n${x.text}\n` : `\n<!-- Nothing readable without a model (${x.method}). /ingest: read the original at ${rel(root, dest)} and write the text, formulas as LaTeX and code here. -->\n`));
      extractedRel = rel(root, exFile);
      if (type === 'syllabus') {
        const written = maybeWriteSyllabus(L.subject(subject), subject, x.text);
        if (written) res.syllabusWritten.push(rel(root, written));
      }
    } else {
      status = 'unsorted';
      dest = join(L.inbox, 'unsorted', `${id}${ext}`);
      mkdirSync(join(L.inbox, 'unsorted'), { recursive: true });
      copyFileSync(file, dest);
      res.unsorted.push(relSrc);
    }
    const row: AssetRow = { id, subject: subject ?? null, week: week ?? null, type, title: basename(file), original: relSrc, path: rel(root, dest), extracted: extractedRel, sha, needsClaude: x.needsClaude, status, at: now };
    db.sql
      .prepare('INSERT INTO assets (id, subject, week, type, title, original, path, extracted, sha, needs_claude, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.subject, row.week, row.type, row.title, row.original, row.path, row.extracted, row.sha, row.needsClaude ? 1 : 0, row.status, row.at);
    if (subject) res.added.push(row);
    if (opts.move) rmSync(file, { force: true });
  }
  return res;
}

/** An outline dropped in as a file fills an empty syllabus.md (never one that already has topics). */
function maybeWriteSyllabus(subjectDir: string, subject: string, text: string): string | null {
  const file = join(subjectDir, 'syllabus.md');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (parseSyllabus(current, subject).length) return null;
  if (parseSyllabus(text, subject).length < 3) return null;
  writeFileSync(file, `${current.trim() ? `${current.trim()}\n\n` : ''}${text.trim()}\n`);
  return file;
}

/** New work for the 2-hourly ingest job: files waiting in inbox/ and assets not processed by Claude yet. */
export function pending(db: StudyDb, root: string) {
  const L = layout(root);
  const inbox = existsSync(L.inbox) ? listFiles(L.inbox).filter((f) => !f.endsWith('.gitkeep')) : [];
  const unsorted = existsSync(join(L.inbox, 'unsorted')) ? readdirSync(join(L.inbox, 'unsorted')).filter((f) => !IGNORE.test(f)) : [];
  const fresh = listAssets(db, { status: 'new' });
  return { inbox: inbox.map((f) => rel(root, f)), unsorted: unsorted.map((f) => `inbox/unsorted/${f}`), newAssets: fresh.map((a) => a.id), total: inbox.length + unsorted.length + fresh.length };
}
