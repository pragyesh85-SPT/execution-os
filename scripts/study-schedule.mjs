// Registers the Study OS headless jobs in Windows Task Scheduler (run by the owner, once):
//   npm run study:schedule -- --vault C:\StudyOS            register (or update) every task
//   npm run study:schedule -- --vault C:\StudyOS --dry-run  print the schtasks commands only
//   npm run study:schedule -- --remove                      delete every Study OS task
// Each task runs `<vault>\study.cmd run-job <job>` in the vault. Jobs check for work first, so the
// frequent ones (ingest every 2 hours, grade every 30 minutes) cost nothing when there is nothing to do.
// Tasks run while you are signed in to Windows; the PC must be on (heavy jobs are at night).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FOLDER = 'StudyOS';

/** One entry per scheduled job: name, schtasks schedule flags, job. */
export const TASKS = [
  { name: 'Ingest', job: 'ingest', schedule: ['/SC', 'HOURLY', '/MO', '2', '/ST', '00:30'], when: 'every 2 hours, when new files are in inbox/ or assets/' },
  { name: 'Day-end', job: 'day-end', schedule: ['/SC', 'DAILY', '/ST', '01:00'], when: 'nightly at 1:00' },
  { name: 'Build-test', job: 'build-test', schedule: ['/SC', 'DAILY', '/MO', '3', '/ST', '05:00'], when: 'every 3rd day at 5:00 (skips unless a test is due)' },
  { name: 'Grade', job: 'grade', schedule: ['/SC', 'MINUTE', '/MO', '30'], when: 'every 30 minutes, when a test was submitted' },
  { name: 'Week-end', job: 'week-end', schedule: ['/SC', 'WEEKLY', '/D', 'SUN', '/ST', '22:00'], when: 'Sunday at 22:00' },
];

/** The schtasks argument lists for a vault. */
export function taskCommands(vault) {
  const shim = join(vault, 'study.cmd');
  return TASKS.map((t) => ({
    ...t,
    // Node passes an embedded quote as \" — the form schtasks expects inside /TR — when the path has spaces.
    args: ['/Create', '/F', '/TN', `${FOLDER}\\${t.name}`, '/TR', `${/\s/.test(shim) ? `"${shim}"` : shim} run-job ${t.job}`, ...t.schedule, '/RL', 'LIMITED'],
  }));
}

export const removeCommands = () => TASKS.map((t) => ({ ...t, args: ['/Delete', '/F', '/TN', `${FOLDER}\\${t.name}`] }));

function vaultFromConfig() {
  const appData = process.env.APPDATA ?? join(homedir(), '.config');
  const db = process.env.EOS_DB ?? join(appData, 'execution-os', 'execution-os.db');
  const file = join(db, '..', 'study.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')).vault;
  } catch {
    return undefined;
  }
}

function main(argv) {
  const dry = argv.includes('--dry-run');
  const remove = argv.includes('--remove');
  const i = argv.indexOf('--vault');
  const vault = resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : process.env.EOS_STUDY_VAULT || vaultFromConfig() || 'C:\\StudyOS');
  if (!remove && !existsSync(join(vault, 'vault.yaml'))) {
    console.error(`No Study Vault at ${vault}. Create it first: npm run study -- init "${vault}"`);
    return 1;
  }
  if (!remove && !existsSync(join(vault, 'study.cmd'))) {
    console.error(`${vault}\\study.cmd is missing. Re-run: npm run build:node && npm run study -- init "${vault}"`);
    return 1;
  }
  if (process.platform !== 'win32' && !dry) {
    console.error('Task Scheduler is Windows only. On macOS / Linux use cron with: <vault>/study run-job <job>. (--dry-run shows the jobs.)');
    return 1;
  }
  const list = remove ? removeCommands() : taskCommands(vault);
  let failed = 0;
  for (const t of list) {
    const line = `schtasks ${t.args.map((a) => (/\s/.test(a) && !a.startsWith('"') ? `"${a}"` : a)).join(' ')}`;
    if (dry) {
      console.log(`${t.name.padEnd(11)} ${remove ? 'remove' : t.when}\n  ${line}`);
      continue;
    }
    const r = spawnSync('schtasks', t.args, { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) console.log(`${remove ? 'Removed' : 'Registered'} ${FOLDER}\\${t.name}${remove ? '' : ` — ${t.when}`}`);
    else {
      failed++;
      console.error(`${FOLDER}\\${t.name}: ${(r.stderr || r.stdout || '').trim()}`);
    }
  }
  if (dry) console.log('\nDry run: nothing was registered.');
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
