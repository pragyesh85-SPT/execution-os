import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub, type Hub } from '../server/hub';
import { StudyDb } from '../server/study/store';
import { STUDY_MIGRATIONS } from '../server/study/migrations';
import { initVault, insideEngineRepo, isVault, layout } from '../server/study/vault';
import { runStudyCli } from '../server/study/cli';
import { StudyConfigFile } from '../server/study/config';
import { emptyDoc } from '../src/core/defaults';
import { FEATURE_DEFAULTS, FEATURE_INFO, isOn } from '../src/core/features';
import { normalizeDoc } from '../src/core/merge';
import * as ops from '../src/core/ops';
import { describeRec } from '../src/core/sync';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eos-study0-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const hasGit = spawnSync('git', ['--version']).status === 0;

describe('study flag and the synced summary', () => {
  it('is off by default and listed in Labs', () => {
    expect(FEATURE_DEFAULTS.study).toBe(false);
    expect(isOn(emptyDoc().settings, 'study')).toBe(false);
    expect(isOn({ features: { study: true } }, 'study')).toBe(true);
    expect(FEATURE_INFO.study.label).toBe('Study OS');
  });

  it('adds one empty synced collection that older docs gain on load', () => {
    expect(emptyDoc().study).toEqual({});
    const old = emptyDoc() as Partial<ReturnType<typeof emptyDoc>>;
    delete old.study;
    expect(normalizeDoc(old).study).toEqual({});
    expect(describeRec('study', { id: 'summary', u: 1 })).toBe('Study summary');
  });
});

describe('study.db', () => {
  it('creates a fresh store at the latest schema without a backup', () => {
    const f = join(dir, 'fresh', 'study.db');
    const db = new StudyDb(f);
    expect(db.schemaVersion).toBe(1);
    expect(db.migration.ran).toEqual(['study-v1']);
    expect(db.migration.backup).toBe('');
    db.addEvent({ kind: 'segment_done', concept: 'c1', source: 'app', data: { url: 'https://x' } });
    expect(db.events({ concept: 'c1' })[0]).toMatchObject({ kind: 'segment_done', data: { url: 'https://x' } });
    db.close();
    const again = new StudyDb(f);
    expect(again.migration.ran).toEqual([]);
    expect(again.events().length).toBe(1);
    again.close();
  });

  it('copies an existing store before a migration and rolls back a failed one', () => {
    const f = join(dir, 'mig', 'study.db');
    new StudyDb(f).close();
    const v2 = [...STUDY_MIGRATIONS, { to: 2, name: 'add-x', up: (d: import('node:sqlite').DatabaseSync) => d.exec('ALTER TABLE events ADD COLUMN x TEXT') }];
    const db = new StudyDb(f, { migrations: v2 });
    expect(db.schemaVersion).toBe(2);
    expect(db.migration.backup).toMatch(/pre-migration-v1-to-v2-/);
    expect(existsSync(db.migration.backup!)).toBe(true);
    db.close();
    const bad = [...v2, { to: 3, name: 'broken', up: (d: import('node:sqlite').DatabaseSync) => d.exec('ALTER TABLE nope ADD COLUMN y TEXT') }];
    expect(() => new StudyDb(f, { migrations: bad })).toThrow();
    const after = new StudyDb(f, { migrations: v2 });
    expect(after.schemaVersion).toBe(2);
    after.close();
  });

  it('keeps one backup per day, 14 days', () => {
    const f = join(dir, 'bk', 'study.db');
    const db = new StudyDb(f);
    mkdirSync(db.backupDir, { recursive: true });
    for (let i = 1; i <= 16; i++) writeFileSync(join(db.backupDir, `study-2026-09-${String(i).padStart(2, '0')}.db`), '');
    const today = db.backupIfDue();
    expect(today && existsSync(today)).toBe(true);
    expect(db.backups().length).toBe(14);
    expect(db.backups()[0]).toBe(today!.split(/[\\/]/).pop());
    db.close();
  });
});

describe('the Study Vault', () => {
  it('is created from the template, completed but never overwritten on a second run', () => {
    const root = join(dir, 'vault-a');
    const r = initVault(root, { engine: join(dir, 'engine', 'study.cjs'), node: 'node', git: false, today: '2026-10-28' });
    expect(isVault(root)).toBe(true);
    expect(r.created).toEqual(expect.arrayContaining(['CLAUDE.md', 'STATE.md', 'vault.yaml', join('semesters', 's1', 'assessment.yaml')]));
    for (const s of ['lana', 'fsp', 'ata', 'bda']) for (const d of ['assets', 'extracted', 'concepts', 'paths', 'packs', 'labs', 'questions']) expect(existsSync(join(layout(root).subject(s), d))).toBe(true);
    expect(readFileSync(join(root, 'vault.yaml'), 'utf8')).toContain('createdAt: 2026-10-28');
    expect(readFileSync(join(root, 'study.cmd'), 'utf8')).toContain('study.cjs');
    writeFileSync(join(root, 'CLAUDE.md'), 'my own rules');
    const again = initVault(root, { git: false });
    expect(again.created).toEqual([]);
    expect(again.kept).toContain('CLAUDE.md');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('my own rules');
  });

  it('refuses to live inside the Execution OS repo', () => {
    expect(insideEngineRepo(process.cwd())).toBeTruthy();
    expect(() => initVault(join(process.cwd(), 'StudyOS'), { git: false })).toThrow(/inside the Execution OS repo/);
    expect(existsSync(join(process.cwd(), 'StudyOS'))).toBe(false);
  });

  it.runIf(hasGit)('is a local git repository whose pre-push hook blocks pushing, and ignores data and originals', () => {
    const root = join(dir, 'vault-git');
    const r = initVault(root, {});
    expect(r.git).toBe('initialised');
    expect(readFileSync(join(root, '.git', 'hooks', 'pre-push'), 'utf8')).toContain('push blocked');
    const ignored = (p: string) => spawnSync('git', ['check-ignore', '-q', p], { cwd: root }).status === 0;
    expect(ignored('study.db')).toBe(true);
    expect(ignored('.backups/study-2026-10-28.db')).toBe(true);
    expect(ignored('semesters/s1/subjects/lana/assets/week1.pdf')).toBe(true);
    expect(ignored('semesters/s1/subjects/lana/concepts/lana-x.md')).toBe(false);
    expect(spawnSync('git', ['log', '--oneline'], { cwd: root, encoding: 'utf8' }).stdout).toContain('Study Vault created');
  });
});

describe('repository safety', () => {
  it.runIf(hasGit)('never commits a real vault, its database, keys or office originals', () => {
    const ignored = (p: string) => spawnSync('git', ['check-ignore', '-q', p]).status === 0;
    for (const p of ['StudyOS/CLAUDE.md', 'study.db', 'x/study.db-wal', 'data/study.json', 'notes/w1.pdf', 'slides.pptx', 'local/semesters/s1/subjects/lana/assets/a.txt']) expect(ignored(p), p).toBe(true);
    for (const p of ['templates/study-vault/CLAUDE.md', 'templates/study-vault/.claude/commands/ingest.md', 'tests/fixtures/study-sample/incoming/demo-week1-slides.md']) expect(ignored(p), p).toBe(false);
  });

  it('ships a template with no keys and no course material', () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const files = walk(join(process.cwd(), 'templates', 'study-vault'));
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/sk-ant-[a-z0-9]|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}/);
    }
    expect(files.some((f) => /assets[\\/].+\.\w+$/.test(f))).toBe(false);
  });
});

describe('hub routes', () => {
  const PORT = 47995;
  const base = `http://127.0.0.1:${PORT}/api/study`;
  let hub: Hub;
  let vault: string;

  beforeAll(async () => {
    vault = join(dir, 'hub-vault');
    hub = await startHub({ port: PORT, dbFile: join(dir, 'hub', 'execution-os.db'), distDir: join(dir, 'dist'), study: { vault } });
  });
  afterAll(async () => {
    await hub.close();
  });

  it('answers 404 while the flag is off, and opens nothing', async () => {
    const r = await fetch(`${base}/status`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/switched off/);
    expect(hub.study.service()).toBeNull();
  });

  it('explains how to create the vault once the flag is on', async () => {
    hub.db.mutate(ops.setFeature('study', true), 'test');
    const setup = await (await fetch(`${base}/setup`)).json();
    expect(setup).toMatchObject({ enabled: true, exists: false, vault });
    const r = await fetch(`${base}/status`);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/study -- init/);
  });

  it('serves the vault status and makes the first daily backup', async () => {
    initVault(vault, { git: false });
    const s = (await (await fetch(`${base}/status`)).json()) as { semester: string; counts: { concepts: number } };
    expect(s.semester).toBe('s1');
    expect(s.counts.concepts).toBe(0);
    expect(readdirSync(join(vault, '.backups')).some((f) => f.startsWith('study-'))).toBe(true);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it('closes the vault again when the flag is switched off', async () => {
    hub.db.mutate(ops.setFeature('study', false), 'test');
    expect((await fetch(`${base}/status`)).status).toBe(404);
    expect(hub.study.service()).toBeNull();
  });
});

describe('study CLI', () => {
  it('init → status → next, with the vault remembered next to the Execution OS database', async () => {
    const eosDb = join(dir, 'cli', 'execution-os.db');
    const vault = join(dir, 'cli-vault');
    const lines: string[] = [];
    const env = { eosDb, hub: false as const, out: (s: string) => lines.push(s), err: (s: string) => lines.push(`ERR ${s}`) };
    expect(await runStudyCli(['init', vault], { ...env, engine: join(dir, 'study.cjs') })).toBe(0);
    expect(lines.join('\n')).toContain('Study Vault ready');
    expect(new StudyConfigFile(eosDb).read().vault).toBe(vault);
    lines.length = 0;
    expect(await runStudyCli(['status'], env)).toBe(0);
    expect(lines.join('\n')).toMatch(/semester s1 · hub not running/);
    lines.length = 0;
    expect(await runStudyCli(['next', '--json'], env)).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toEqual({ items: [] });
    expect(await runStudyCli(['frobnicate'], env)).toBe(2);
  });

  it('refuses to run without a vault', async () => {
    const errs: string[] = [];
    const eosDb = join(dir, 'none', 'execution-os.db');
    new StudyConfigFile(eosDb).write({ vault: join(dir, 'no-such-vault') }); // never fall back to the real default folder
    const code = await runStudyCli(['status'], { eosDb, hub: false, out: () => {}, err: (s) => errs.push(s) });
    expect(code).toBe(1);
    expect(errs[0]).toMatch(/No Study Vault/);
  });
});
