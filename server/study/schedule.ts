import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, win32 } from 'node:path';

// Windows Task Scheduler for the headless Claude jobs, used by the Study tab (PC only) and
// `study schedule`. Keep TASKS in step with scripts/study-schedule.mjs (a test compares them).
// Each task runs `<vault>\study.cmd run-job <job>`; jobs check for work first, so the frequent ones cost
// nothing when there is nothing to do. Tasks run while you are signed in to Windows.

export const FOLDER = 'StudyOS';

export const TASKS = [
  { name: 'Ingest', job: 'ingest', schedule: ['/SC', 'HOURLY', '/MO', '2', '/ST', '00:30'], when: 'every 2 hours, when new files are in inbox/ or assets/' },
  { name: 'Day-end', job: 'day-end', schedule: ['/SC', 'DAILY', '/ST', '01:00'], when: 'nightly at 1:00' },
  { name: 'Build-test', job: 'build-test', schedule: ['/SC', 'DAILY', '/MO', '3', '/ST', '05:00'], when: 'every 3rd day at 5:00 (skips unless a test is due)' },
  { name: 'Grade', job: 'grade', schedule: ['/SC', 'MINUTE', '/MO', '30'], when: 'every 30 minutes, when a test was submitted' },
  { name: 'Week-end', job: 'week-end', schedule: ['/SC', 'WEEKLY', '/D', 'SUN', '/ST', '22:00'], when: 'Sunday at 22:00' },
];

export function taskArgs(vault: string) {
  const shim = win32.join(vault, 'study.cmd'); // Task Scheduler is Windows: always a Windows path
  return TASKS.map((t) => ({ ...t, args: ['/Create', '/F', '/TN', `${FOLDER}\\${t.name}`, '/TR', `${/\s/.test(shim) ? `"${shim}"` : shim} run-job ${t.job}`, ...t.schedule, '/RL', 'LIMITED'] }));
}

export interface ScheduleStatus {
  supported: boolean; // Windows only
  claude: string | null; // Claude Code version, null when the `claude` command is not found
  tasks: { name: string; job: string; when: string; registered: boolean; nextRun: string | null }[];
}

let claudeCache: { at: number; v: string | null } | null = null;

/** Is Claude Code installed (needed by every job)? Cached for 5 minutes. */
export function claudeVersion(): string | null {
  if (claudeCache && Date.now() - claudeCache.at < 300_000) return claudeCache.v;
  const cmd = process.env.STUDY_CLAUDE || 'claude';
  // On Windows `claude` is a .cmd shim, which needs a shell; one command string avoids unescaped args.
  const r = process.platform === 'win32' ? spawnSync(`"${cmd}" --version`, { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: true }) : spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  const v = r.status === 0 ? r.stdout.trim().split('\n')[0].slice(0, 80) : null;
  claudeCache = { at: Date.now(), v };
  return v;
}

export function scheduleStatus(): ScheduleStatus {
  const supported = process.platform === 'win32';
  const tasks = TASKS.map((t) => {
    if (!supported) return { name: t.name, job: t.job, when: t.when, registered: false, nextRun: null };
    const r = spawnSync('schtasks', ['/Query', '/TN', `${FOLDER}\\${t.name}`, '/FO', 'LIST'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    const next = r.status === 0 ? /Next Run Time:\s*(.+)/i.exec(r.stdout)?.[1]?.trim() ?? null : null;
    return { name: t.name, job: t.job, when: t.when, registered: r.status === 0, nextRun: next };
  });
  return { supported, claude: claudeVersion(), tasks };
}

/** Register (or with remove: delete) every task. dryRun returns the commands without running them. */
export function applySchedule(vault: string, opts: { remove?: boolean; dryRun?: boolean } = {}): { ok: boolean; lines: string[] } {
  if (!opts.remove && !existsSync(join(vault, 'study.cmd'))) return { ok: false, lines: [`${join(vault, 'study.cmd')} is missing — create the vault again from the Study tab (it adds the file).`] };
  const list = opts.remove ? TASKS.map((t) => ({ ...t, args: ['/Delete', '/F', '/TN', `${FOLDER}\\${t.name}`] })) : taskArgs(vault);
  if (opts.dryRun) return { ok: true, lines: list.map((t) => `schtasks ${t.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`) };
  if (process.platform !== 'win32') return { ok: false, lines: ['Task Scheduler is Windows only. Use cron with: <vault>/study run-job <job>.'] };
  const lines: string[] = [];
  let ok = true;
  for (const t of list) {
    const r = spawnSync('schtasks', t.args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (r.status === 0) lines.push(`${opts.remove ? 'Removed' : 'Registered'} ${FOLDER}\\${t.name}${opts.remove ? '' : ` — ${t.when}`}`);
    else {
      ok = opts.remove ? ok : false; // removing a task that was never registered is fine
      lines.push(`${FOLDER}\\${t.name}: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  return { ok, lines };
}

/** Start one job now, in the background (logs land in <vault>/logs, the result on the Study home). */
export function startJobNow(job: string, vault: string, engine: string, env: Record<string, string>): void {
  const child = spawn(process.execPath, [engine, 'run-job', job, '--force'], { cwd: vault, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env } });
  child.unref();
}
