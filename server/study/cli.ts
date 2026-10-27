import '../quiet';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { METHODS } from './api';
import { StudyConfigFile } from './config';
import { StudyService } from './service';
import { defaultVaultPath, initVault, isVault } from './vault';
import type { QueueItem } from '../../src/core/study/types';

// The `study` command line — for you and for Claude Code inside the vault.
//   study init <vault-path>     create the Study Vault (template, git, `study` shims)
//   study ingest <folder>       copy, classify and extract new assets, then index
//   study status                what the vault holds, parse errors, last jobs
//   study next                  the queue: repairs, reviews, tests, next concepts
//   … `study help` lists everything.
// When the hub (Execution OS) is running, every command goes through its Study API, so study.db keeps
// one writer. When it is not running, the CLI opens the vault directly (nothing else is writing then).

export interface CliEnv {
  out?: (s: string) => void;
  err?: (s: string) => void;
  eosDb?: string; // Execution OS database (decides where study.json lives)
  port?: number;
  engine?: string; // path of build/study.cjs for the vault shims
  clock?: () => number;
  hub?: boolean; // false: never try the hub (tests)
}

export interface Client {
  mode: 'hub' | 'local';
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export class CliError extends Error {}

const appData = () => process.env.APPDATA ?? join(homedir(), '.config');
export const eosDbPath = () => process.env.EOS_DB ?? join(appData(), 'execution-os', 'execution-os.db');

async function hubUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { app?: string }).app === 'execution-os';
  } catch {
    return false;
  }
}

/** The "study" flag as saved in the Execution OS database (used only when the hub is not running). */
export function flagInDb(dbFile: string): boolean | null {
  if (!existsSync(dbFile)) return null;
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = db.prepare("SELECT data FROM records WHERE col = 'settings' AND id = 'settings'").get() as { data: string } | undefined;
      const f = row ? (JSON.parse(row.data) as { features?: Record<string, boolean> }).features?.study : undefined;
      return f ?? false;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function connect(env: CliEnv, vault: string): Promise<Client> {
  const port = env.port ?? Number(process.env.EOS_PORT ?? 4747);
  if (env.hub !== false && (await hubUp(port))) {
    const base = `http://127.0.0.1:${port}/api/study`;
    return {
      mode: 'hub',
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        const res = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EOS-DEVICE': 'study CLI' }, body: JSON.stringify(params), signal: AbortSignal.timeout(10 * 60_000) });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new CliError(body.error ?? `The hub answered ${res.status}`);
        return body as T;
      },
      close() {},
    };
  }
  const flag = flagInDb(env.eosDb ?? eosDbPath());
  if (flag === false) throw new CliError('Study OS is switched off. Turn it on in Execution OS → Settings → Labs → Study OS.');
  const svc = new StudyService({ vault, clock: env.clock });
  return {
    mode: 'local',
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      const m = METHODS[method];
      if (!m) throw new CliError(`Unknown Study OS method "${method}".`);
      return (await m.run(svc, params, { local: true, device: 'cli' })) as T;
    },
    close: () => svc.close(),
  };
}

type Out = (s: string) => void;
interface Cmd {
  usage: string;
  help: string;
  noVault?: boolean;
  run: (args: string[], ctx: { client: () => Promise<Client>; out: Out; json: boolean; env: CliEnv; config: StudyConfigFile; vault: string }) => Promise<void>;
}

const print = (out: Out, json: boolean, value: unknown, human: () => string) => out(json ? JSON.stringify(value, null, 2) : human());

export const COMMANDS: Record<string, Cmd> = {
  init: {
    usage: 'study init <vault-path>',
    help: 'Create the Study Vault (or complete an existing one). Never overwrites a file.',
    noVault: true,
    async run(args, { out, json, env, config }) {
      const target = resolve(args[0] ?? config.vault());
      const r = initVault(target, { engine: env.engine, node: process.execPath });
      config.write({ vault: target });
      print(out, json, r, () =>
        [
          `Study Vault ready at ${r.root}`,
          `  ${r.created.length} file(s) created, ${r.kept.length} kept as they were · git: ${r.git}`,
          `  Saved as the vault for this PC in ${config.file}`,
          '',
          'Next:',
          '  1. Execution OS → Settings → Labs → switch on "Study OS".',
          `  2. Put each subject's full outline in ${join(r.root, 'semesters', 's1', 'subjects', '<subject>', 'syllabus.md')}.`,
          '  3. study ingest <folder with the IITJ assets>',
        ].join('\n'),
      );
    },
  },
  status: {
    usage: 'study status',
    help: 'What the vault holds, files that did not parse, last jobs.',
    async run(_a, { client, out, json }) {
      const c = await client();
      const s = (await c.call('status')) as ReturnType<StudyService['status']>;
      print(out, json, { mode: c.mode, ...s }, () => {
        const lines = [
          `${s.name} · ${s.vault} · semester ${s.semester} · ${c.mode === 'hub' ? 'via the hub' : 'hub not running (direct)'}`,
          `  concepts ${s.counts.concepts} · paths ${s.counts.paths} · packs ${s.counts.packs} · labs ${s.counts.labs} · questions ${s.counts.questions} · assets ${s.counts.assets} · events ${s.counts.events}`,
        ];
        if (s.errors.length) lines.push(`  ${s.errors.length} file(s) did not parse:`, ...s.errors.slice(0, 20).map((e) => `    ${e.path}: ${e.error}`));
        return lines.join('\n');
      });
    },
  },
  next: {
    usage: 'study next',
    help: 'The queue: repairs first, then due reviews, the 3-day test, the next concepts.',
    async run(_a, { client, out, json }) {
      const c = await client();
      const r = (await c.call('next')) as { items: QueueItem[] };
      print(out, json, r, () => (r.items.length ? r.items.map((i, n) => `${String(n + 1).padStart(2)}. [${i.kind}] ${i.title} — ${i.why}`).join('\n') : 'Nothing queued yet. Add the syllabus and run: study ingest <folder>'));
    },
  },
};

const HELP_ORDER = () => Object.keys(COMMANDS);

export function helpText(): string {
  return ['study — Study OS command line', '', ...HELP_ORDER().map((k) => `  ${COMMANDS[k].usage.padEnd(44)} ${COMMANDS[k].help}`), '', 'Add --json for machine-readable output.'].join('\n');
}

export async function runStudyCli(argv: string[], env: CliEnv = {}): Promise<number> {
  const out = env.out ?? ((s: string) => console.log(s));
  const err = env.err ?? ((s: string) => console.error(s));
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const [name = 'help', ...rest] = args;
  if (name === 'help' || name === '--help' || name === '-h') {
    out(helpText());
    return 0;
  }
  if (name === 'version' || name === '--version') {
    out(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev');
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    err(`Unknown command "${name}".\n\n${helpText()}`);
    return 2;
  }
  const config = new StudyConfigFile(env.eosDb ?? eosDbPath());
  const vault = config.vault();
  let client: Client | null = null;
  try {
    if (!cmd.noVault && !isVault(vault)) throw new CliError(`No Study Vault at ${vault}. Create it first: study init ${vault === defaultVaultPath() ? defaultVaultPath() : vault}`);
    await cmd.run(rest, {
      out,
      json,
      env,
      config,
      vault,
      client: async () => (client ??= await connect(env, vault)),
    });
    return 0;
  } catch (e) {
    err((e as Error).message);
    return 1;
  } finally {
    (client as Client | null)?.close();
  }
}
