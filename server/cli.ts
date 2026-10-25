import './quiet';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileStamp } from './db';
import { startHub } from './hub';

// Command line for the hub: `node build/server.cjs <command>`
//   serve (default)   start the hub: web app + sync API for every device on this Wi-Fi
//   backup            write a labelled copy of the database into the backups folder
//   restore <file>    replace the database with a backup (refuses while the hub is running)
//   info              database path, record count, schema version, backups
//   version           print the app version
// These are the owner's emergency tools — they work even when the app will not start.

const root = resolve(dirname(process.argv[1] ?? '.'), '..');
const port = Number(process.env.EOS_PORT ?? 4747);
// Same database as the Windows app, so there is exactly one source of truth on this PC.
const appData = process.env.APPDATA ?? join(homedir(), '.config');
const dbFile = process.env.EOS_DB ?? join(appData, 'execution-os', 'execution-os.db');
const backupDir = join(dirname(dbFile), 'backups');

// Import the old v1 JSON store only into the real database — never into a custom/test one.
const legacyJson = process.env.EOS_DB ? undefined : join(appData, 'execution-os', 'execution-os.json');

const [command = 'serve', ...args] = process.argv.slice(2);

const stamp = () => fileStamp();
const quote = (p: string) => `'${p.replace(/'/g, "''")}'`;

async function hubRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = (await res.json()) as { app?: string };
    return j.app === 'execution-os';
  } catch {
    return false;
  }
}

function vacuumInto(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${quote(target)}`);
  } finally {
    db.close();
  }
}

function describeDb(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const records = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
    const versions = (db.prepare('SELECT COUNT(*) AS n FROM history').get() as { n: number }).n;
    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta WHERE key IN ('rev','schemaVersion')").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    return { records, versions, rev: Number(meta.rev ?? 0), schemaVersion: Number(meta.schemaVersion ?? 1) };
  } finally {
    db.close();
  }
}

function serve() {
  startHub({ port, dbFile, legacyJson, distDir: join(root, 'dist'), log: (m) => console.log(m) })
    .then((hub) => {
      console.log('');
      console.log(`  Execution OS ${__APP_VERSION__} is running`);
      console.log(`  This PC:        http://localhost:${port}`);
      for (const e of hub.endpoints()) console.log(`  ${e.kind === 'tailscale' ? 'Phone (anywhere, Tailscale)' : 'Phone (home Wi-Fi)'}: ${e.url}`);
      console.log(`  Pairing PIN:    ${hub.pin}`);
      console.log(`  Database:       ${dbFile}`);
      console.log('');
      console.log('  Press Ctrl+C to stop.');
      const stop = () => hub.close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use — Execution OS (or the desktop app) is probably already running.`);
        console.error(`Open http://localhost:${port} in your browser.`);
      } else {
        console.error(err);
      }
      process.exit(1);
    });
}

function backup() {
  if (!existsSync(dbFile)) return fail(`No database at ${dbFile}`);
  const target = join(backupDir, `manual-${stamp()}.db`);
  vacuumInto(dbFile, target);
  console.log(`Backup written: ${target}`);
}

async function restore(file: string | undefined) {
  if (!file) return fail('Usage: node build/server.cjs restore <backup.db>');
  const source = resolve(file);
  if (!existsSync(source)) return fail(`File not found: ${source}`);
  if (await hubRunning()) return fail('Execution OS is running. Quit it first (tray icon → Quit), then run restore again.');
  let info: ReturnType<typeof describeDb>;
  try {
    info = describeDb(source);
  } catch (e) {
    return fail(`That file is not an Execution OS database: ${(e as Error).message}`);
  }
  if (existsSync(dbFile)) {
    const safety = join(backupDir, `pre-restore-${stamp()}.db`);
    vacuumInto(dbFile, safety);
    console.log(`Current database saved first: ${safety}`);
  }
  mkdirSync(dirname(dbFile), { recursive: true });
  for (const ext of ['-wal', '-shm']) rmSync(dbFile + ext, { force: true });
  copyFileSync(source, dbFile);
  console.log(`Restored ${info.records} records (revision ${info.rev}, schema v${info.schemaVersion}) from ${source}`);
  console.log('Start Execution OS again. Phones re-sync automatically.');
}

async function info() {
  console.log(`Execution OS ${__APP_VERSION__}`);
  console.log(`Database:   ${dbFile}`);
  if (existsSync(dbFile)) {
    const d = describeDb(dbFile);
    console.log(`Records:    ${d.records} (${d.versions} versions kept), revision ${d.rev}, schema v${d.schemaVersion}`);
  } else {
    console.log('Records:    (no database yet — it is created on first start)');
  }
  const files = existsSync(backupDir) ? readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort().reverse() : [];
  console.log(`Backups:    ${backupDir} (${files.length})`);
  for (const f of files.slice(0, 8)) console.log(`  ${f}`);
  console.log(`Hub:        ${(await hubRunning()) ? `running on port ${port}` : 'not running'}`);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

switch (command) {
  case 'serve':
    serve();
    break;
  case 'backup':
    backup();
    break;
  case 'restore':
    void restore(args[0]);
    break;
  case 'info':
    void info();
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(__APP_VERSION__);
    break;
  default:
    fail(`Unknown command "${command}". Commands: serve, backup, restore <file>, info, version`);
}
