import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileStamp } from '../db';
import { commitVault, MANAGED } from './vault';
import { frontMatter } from './yaml';

// Headless Claude jobs. Windows Task Scheduler runs `study run-job <job>` in the vault; this file:
//   1. checks the job's gate (only run when there is work: new files, a test due, a test submitted)
//   2. runs `claude -p` once per command file in .claude/commands/ (model from its front matter, sonnet
//      by default), in the vault folder, with its output in logs/<job>-<stamp>.log
//   3. records ok / failed with the log path (shown on the Study home: "last ingest failed")
//   4. regenerates STATE.md and commits the vault, so every run can be undone with git
// Every job is safe to re-run; the same command can be run by hand in Claude Code (/ingest …).

export interface JobDef {
  chain: string[]; // command files, in order
  gate?: 'pending' | 'build-test' | 'grade';
  timeoutMin: number;
}

export const JOBS: Record<string, JobDef> = {
  ingest: { chain: ['ingest', 'curate', 'packs', 'labs'], gate: 'pending', timeoutMin: 45 },
  curate: { chain: ['curate'], timeoutMin: 45 },
  packs: { chain: ['packs'], timeoutMin: 30 },
  labs: { chain: ['labs'], timeoutMin: 30 },
  'day-end': { chain: ['day-end', 'curate'], timeoutMin: 60 },
  'build-test': { chain: ['build-test'], gate: 'build-test', timeoutMin: 45 },
  grade: { chain: ['grade'], gate: 'grade', timeoutMin: 45 },
  'week-end': { chain: ['week-end'], timeoutMin: 60 },
};

export interface JobClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

export interface RunJobOptions {
  vault: string;
  client: JobClient;
  claude?: string[]; // command to run Claude Code (default: STUDY_CLAUDE or "claude")
  now?: () => number;
  force?: boolean; // ignore the gate
  log?: (s: string) => void;
}

export interface JobRun {
  job: string;
  ran: boolean;
  ok: boolean;
  reason?: string;
  log?: string;
  steps: { command: string; ok: boolean; code: number | null; ms: number }[];
}

/** A command file → { model, prompt }. $ARGUMENTS becomes the given argument text. */
export function readCommand(vault: string, name: string, args = ''): { model: string; prompt: string } {
  const file = join(vault, '.claude', 'commands', `${name}.md`);
  if (!existsSync(file)) throw new Error(`Missing job file .claude/commands/${name}.md — run: study init "${vault}" (it adds missing files)`);
  const { meta, body } = frontMatter(readFileSync(file, 'utf8'), file);
  // the managed-file marker is bookkeeping for the app, not an instruction for Claude
  const prompt = body
    .split('\n')
    .filter((l) => !l.includes(MANAGED))
    .join('\n');
  return { model: typeof meta.model === 'string' ? meta.model : 'sonnet', prompt: prompt.replace(/\$ARGUMENTS/g, args).trim() };
}

function claudeCmd(opt?: string[]): string[] {
  if (opt?.length) return opt;
  return [process.env.STUDY_CLAUDE || 'claude'];
}

function runClaude(cmd: string[], vault: string, c: { model: string; prompt: string }, logFile: string, timeoutMin: number): Promise<{ code: number | null; ms: number }> {
  const t0 = Date.now();
  // The prompt goes in on stdin (no quoting problems with long, multi-line text); tool permissions come
  // from the vault's .claude/settings.json.
  const model = /^[a-z0-9.\-]+$/i.test(c.model) ? c.model : 'sonnet';
  const args = [...cmd.slice(1), '-p', '--model', model, '--permission-mode', 'acceptEdits', '--output-format', 'text'];
  return new Promise((resolve) => {
    const child = spawn(cmd[0], args, { cwd: vault, windowsHide: true, shell: process.platform === 'win32' && !/\.(exe|cjs|mjs|js)$/i.test(cmd[0]) && cmd[0] !== process.execPath, env: { ...process.env, STUDY_VAULT: vault } });
    child.stdin?.on('error', () => {});
    child.stdin?.end(c.prompt);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMin * 60_000);
    const write = (b: Buffer) => appendFileSync(logFile, b);
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
    child.on('error', (e) => {
      appendFileSync(logFile, `\n[study] could not start Claude Code: ${e.message}\n`);
      clearTimeout(timer);
      resolve({ code: -1, ms: Date.now() - t0 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, ms: Date.now() - t0 });
    });
  });
}

/** Is there work for this job? */
async function gate(def: JobDef, client: JobClient): Promise<string | null> {
  if (def.gate === 'pending') {
    const p = await client.call<{ total: number }>('pending');
    return p.total ? null : 'nothing new in inbox/ or assets/';
  }
  if (def.gate === 'build-test') {
    const d = await client.call<{ due: boolean; reason: string; id: string }>('testBuildDue');
    return d.due ? null : d.reason;
  }
  if (def.gate === 'grade') {
    const t = await client.call<{ tests: string[] }>('testsAwaitingGrade');
    return t.tests.length ? null : 'no submitted test waits for grading';
  }
  return null;
}

export async function runJob(name: string, o: RunJobOptions): Promise<JobRun> {
  const def = JOBS[name];
  if (!def) throw new Error(`Unknown job "${name}". Jobs: ${Object.keys(JOBS).join(', ')}`);
  const now = o.now ?? Date.now;
  const say = o.log ?? (() => {});
  const run: JobRun = { job: name, ran: false, ok: true, steps: [] };
  if (!o.force) {
    const why = await gate(def, o.client);
    if (why) return { ...run, reason: why };
  }
  const logs = join(o.vault, 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `${name}-${fileStamp(new Date(now()))}.log`);
  const started = now();
  appendFileSync(logFile, `[study] job ${name} started ${new Date(started).toISOString()}\n`);
  run.ran = true;
  run.log = logFile;
  for (const command of def.chain) {
    const c = readCommand(o.vault, command);
    appendFileSync(logFile, `\n[study] ---- /${command} (model ${c.model}) ----\n`);
    say(`running /${command} (${c.model}) …`);
    const r = await runClaude(claudeCmd(o.claude), o.vault, c, logFile, def.timeoutMin);
    run.steps.push({ command, ok: r.code === 0, code: r.code, ms: r.ms });
    if (r.code !== 0) {
      run.ok = false;
      appendFileSync(logFile, `\n[study] /${command} failed (exit ${r.code}); the rest of the chain is skipped.\n`);
      break;
    }
  }
  try {
    await o.client.call('reindex');
    await o.client.call('state');
  } catch (e) {
    appendFileSync(logFile, `\n[study] could not refresh STATE.md: ${(e as Error).message}\n`);
  }
  const commit = commitVault(o.vault, `job: ${name} ${run.ok ? 'ok' : 'FAILED'} ${new Date(started).toISOString().slice(0, 16)}`);
  appendFileSync(logFile, `\n[study] vault commit: ${commit.out || (commit.ok ? 'ok' : 'failed')}\n[study] job ${name} ${run.ok ? 'ok' : 'FAILED'}\n`);
  await o.client.call('jobReport', { job: name, ok: run.ok, started, log: logFile, note: run.steps.map((s) => `${s.command}:${s.ok ? 'ok' : `exit ${s.code}`}`).join(' ') });
  return run;
}
