import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { dumpYaml, parseYaml } from './yaml';

// The Study Vault: a private folder on the PC (default C:\StudyOS), outside the Execution OS repo.
// Claude Code works on its plain files; the hub owns study.db inside it. The repo only ships the
// engine and templates/study-vault, which `study init` copies.

export interface VaultConfig {
  version: 1;
  name: string;
  current: string; // current semester folder, e.g. "s1"
  createdAt: string;
}

export const defaultVaultPath = () => (process.platform === 'win32' ? 'C:\\StudyOS' : join(homedir(), 'StudyOS'));

export const isVault = (root: string) => existsSync(join(root, 'vault.yaml'));

export function readVaultConfig(root: string): VaultConfig {
  const raw = parseYaml(readFileSync(join(root, 'vault.yaml'), 'utf8'), 'vault.yaml') as Partial<VaultConfig>;
  return { version: 1, name: String(raw.name ?? 'Study Vault'), current: String(raw.current ?? 's1'), createdAt: String(raw.createdAt ?? '') };
}

/** Every path the engine uses inside a vault. */
export function layout(root: string, semester?: string) {
  const sem = semester ?? (isVault(root) ? readVaultConfig(root).current : 's1');
  const semDir = join(root, 'semesters', sem);
  return {
    root,
    semester: sem,
    db: join(root, 'study.db'),
    backups: join(root, '.backups'),
    state: join(root, 'STATE.md'),
    inbox: join(root, 'inbox'),
    tests: join(root, 'tests'),
    portfolio: join(root, 'portfolio'),
    logs: join(root, 'logs'),
    sessions: join(root, 'sessions'),
    semDir,
    assessment: join(semDir, 'assessment.yaml'),
    subjectsDir: join(semDir, 'subjects'),
    subject: (id: string) => join(semDir, 'subjects', id),
  };
}

export const SUBJECT_DIRS = ['assets', 'extracted', 'concepts', 'paths', 'packs', 'labs', 'questions'] as const;

/** The vault template shipped with the engine. */
export function templateDir(): string {
  const candidates = [
    process.env.EOS_STUDY_TEMPLATE,
    process.argv[1] ? resolve(dirname(process.argv[1]), '..', 'templates', 'study-vault') : undefined,
    // installed app, CLI run from resources/app.asar.unpacked/build/study.cjs → resources/templates
    process.argv[1] ? resolve(dirname(process.argv[1]), '..', '..', 'templates', 'study-vault') : undefined,
    resolve(process.cwd(), 'templates', 'study-vault'),
    // packaged desktop app: resources/app.asar.unpacked or resources/templates
    (process as { resourcesPath?: string }).resourcesPath ? join((process as { resourcesPath?: string }).resourcesPath!, 'templates', 'study-vault') : undefined,
  ].filter((x): x is string => !!x);
  const found = candidates.find((c) => existsSync(join(c, 'vault.yaml')));
  if (!found) throw new Error(`The Study Vault template was not found (looked in ${candidates.join(', ')}).`);
  return found;
}

/**
 * The `study` CLI bundle next to the running hub: build/study.cjs in a checkout, or inside the installed
 * app (unpacked from app.asar so the shims can run it with `Execution OS.exe` in Node mode).
 */
export function engineEntry(): string | undefined {
  const here = typeof __dirname === 'string' ? __dirname : undefined;
  const candidates = [here && join(here, 'study.cjs'), process.argv[1] ? resolve(dirname(process.argv[1]), 'study.cjs') : undefined].filter((x): x is string => !!x);
  for (const c of candidates) {
    const unpacked = c.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    if (unpacked !== c && existsSync(unpacked)) return unpacked;
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** Is `target` inside a checkout of the Execution OS engine? The vault must never live in the repo. */
export function insideEngineRepo(target: string): string | null {
  let dir = resolve(target);
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === 'execution-os') return dir;
      } catch {
        /* not ours */
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export interface InitOptions {
  engine?: string; // path of build/study.cjs, written into the `study` shims
  node?: string; // node (or Electron) executable for the shims
  git?: boolean; // default true
  name?: string;
  today?: string; // YYYY-MM-DD (tests)
}

export interface InitResult {
  root: string;
  created: string[];
  kept: string[];
  updated: string[]; // managed files refreshed to the engine's version
  git: 'initialised' | 'exists' | 'unavailable' | 'skipped';
}

/** Engine-owned template files (job commands, file formats) carry this marker. While a vault's copy still
 * has it, a newer engine refreshes the file; remove the marker to keep your own edits. */
export const MANAGED = 'study-os:managed';

function copyTree(from: string, to: string, base: string, out: InitResult) {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copyTree(src, dst, base, out);
    } else if (existsSync(dst)) {
      const want = readFileSync(src, 'utf8');
      if (want.includes(MANAGED)) {
        const have = readFileSync(dst, 'utf8');
        if (have !== want && have.includes(MANAGED)) {
          writeFileSync(dst, want);
          out.updated.push(relative(base, dst));
          continue;
        }
      }
      out.kept.push(relative(base, dst));
    } else {
      copyFileSync(src, dst);
      out.created.push(relative(base, dst));
    }
  }
}

const PRE_PUSH = `#!/bin/sh
# Study Vault safety: IITJ assets and study data never leave this PC.
if [ "$STUDYOS_ALLOW_PUSH" != "1" ]; then
  echo "Study Vault: push blocked. This vault is private to this PC (set STUDYOS_ALLOW_PUSH=1 to override)."
  exit 1
fi
`;

export function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** Create (or complete) a vault at `target`. Never overwrites a file that already exists. */
export function initVault(target: string, opts: InitOptions = {}): InitResult {
  const root = resolve(target);
  const repo = insideEngineRepo(root);
  if (repo) throw new Error(`Refusing to create the Study Vault inside the Execution OS repo (${repo}). Pick a folder outside it, e.g. ${defaultVaultPath()}.`);
  mkdirSync(root, { recursive: true });
  const out: InitResult = { root, created: [], kept: [], updated: [], git: 'skipped' };
  const tpl = templateDir();
  copyTree(tpl, root, root, out);

  // vault.yaml from the template carries placeholders; stamp the creation date once.
  const cfgFile = join(root, 'vault.yaml');
  if (out.created.includes('vault.yaml')) {
    const cfg = readVaultConfig(root);
    writeFileSync(cfgFile, dumpYaml({ ...cfg, name: opts.name ?? cfg.name, createdAt: opts.today ?? new Date().toISOString().slice(0, 10) }));
  }
  for (const d of ['inbox', 'tests', 'portfolio', 'logs', 'sessions', '.backups']) mkdirSync(join(root, d), { recursive: true });
  const L = layout(root);
  for (const s of existsSync(L.subjectsDir) ? readdirSync(L.subjectsDir) : []) {
    if (!statSync(L.subject(s)).isDirectory()) continue;
    for (const d of SUBJECT_DIRS) mkdirSync(join(L.subject(s), d), { recursive: true });
  }

  // `study` shims so Claude Code (and you) can type `study …` inside the vault.
  if (opts.engine) {
    const node = opts.node ?? process.execPath;
    writeFileSync(join(root, 'study.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${node}" "${opts.engine}" %*\r\n`);
    const sh = join(root, 'study');
    writeFileSync(sh, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${node.replace(/\\/g, '/')}" "${opts.engine.replace(/\\/g, '/')}" "$@"\n`);
    try {
      chmodSync(sh, 0o755);
    } catch {
      /* Windows */
    }
  }

  if (opts.git !== false) {
    if (existsSync(join(root, '.git'))) out.git = 'exists';
    else if (!git(root, ['--version']).ok) out.git = 'unavailable';
    else {
      git(root, ['init', '-q']);
      const hooks = join(root, '.git', 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(join(hooks, 'pre-push'), PRE_PUSH);
      try {
        chmodSync(join(hooks, 'pre-push'), 0o755);
      } catch {
        /* Windows */
      }
      const ident = git(root, ['config', 'user.email']).ok ? [] : ['-c', 'user.name=Study OS', '-c', 'user.email=study-os@localhost'];
      git(root, ['add', '-A']);
      git(root, [...ident, 'commit', '-q', '-m', 'Study Vault created']);
      out.git = 'initialised';
    }
  }
  return out;
}

/** Refresh the engine-owned files of an existing vault (new job rules after an app update). Quiet on failure. */
export function refreshManaged(root: string): string[] {
  try {
    const out: InitResult = { root, created: [], kept: [], updated: [], git: 'skipped' };
    const tpl = templateDir();
    for (const sub of ['.claude', 'docs']) if (existsSync(join(tpl, sub))) copyTree(join(tpl, sub), join(root, sub), root, out);
    return [...out.updated, ...out.created];
  } catch {
    return [];
  }
}

/** Commit everything Claude (or ingestion) changed. Used after every headless run. */
export function commitVault(root: string, message: string): { ok: boolean; out: string } {
  if (!existsSync(join(root, '.git'))) return { ok: false, out: 'not a git repository' };
  git(root, ['add', '-A']);
  const status = git(root, ['status', '--porcelain']);
  if (status.ok && !status.out) return { ok: true, out: 'nothing to commit' };
  const ident = git(root, ['config', 'user.email']).ok ? [] : ['-c', 'user.name=Study OS', '-c', 'user.email=study-os@localhost'];
  return git(root, [...ident, 'commit', '-q', '-m', message]);
}

/** A vault-relative path with forward slashes (stable ids across Windows and the phone). */
export const rel = (root: string, file: string) => relative(root, file).split(sep).join('/');

/** Resolve a vault-relative path, refusing anything that escapes the vault. */
export function inVault(root: string, relPath: string): string {
  const full = resolve(root, relPath);
  const r = relative(resolve(root), full);
  if (!r || r.startsWith('..') || resolve(r) === r) throw new Error(`Path outside the vault: ${relPath}`);
  return full;
}
