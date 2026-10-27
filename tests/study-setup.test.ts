import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { lanAddresses, startHub, type Hub } from '../server/hub';
import { StudyConfigFile } from '../server/study/config';
import { TASKS, taskArgs } from '../server/study/schedule';
import * as ops from '../src/core/ops';

// Setting Study OS up from the Study tab on the PC (no command line): create the vault, look at the
// scheduled jobs. Nothing is ever registered in the real Task Scheduler here (dry runs only).

const PORT = 47992;
const base = `http://127.0.0.1:${PORT}/api/study`;
let hub: Hub;
let dir: string;
const post = async (m: string, body: unknown = {}) => {
  const r = await fetch(`${base}/${m}`, { method: 'POST', body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eos-study-setup-'));
  const dbFile = join(dir, 'eos', 'execution-os.db');
  new StudyConfigFile(dbFile).write({ vault: join(dir, 'not-yet') }); // never fall back to the real C:\StudyOS
  hub = await startHub({ port: PORT, dbFile, distDir: join(dir, 'dist'), study: { watch: false, engine: join(dir, 'engine', 'study.cjs') } });
  hub.db.mutate(ops.setFeature('study', true), 'test');
});
afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Study setup from the app (PC only)', () => {
  it('reports that this request comes from the PC and that no vault exists yet', async () => {
    const s = await post('setup');
    expect(s.body).toMatchObject({ enabled: true, exists: false, local: true, engine: true });
    expect((await post('overview')).body).toMatchObject({ setup: false });
  });

  it('creates the vault with its shims and remembers it', async () => {
    const path = join(dir, 'MyStudy');
    const r = await post('setupVault', { path });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ root: path, setup: { exists: true, vault: path } });
    expect(readFileSync(join(path, 'study.cmd'), 'utf8')).toContain(join(dir, 'engine', 'study.cjs'));
    expect(new StudyConfigFile(hub.db.file).read().vault).toBe(path);
    expect((await post('status')).body).toMatchObject({ vault: path, semester: 's1' });
  });

  it('shows the scheduled jobs and prints the Task Scheduler commands without registering them', async () => {
    const st = await (await fetch(`${base}/schedule`)).json();
    expect(st.tasks.map((t: { job: string }) => t.job)).toEqual(['ingest', 'day-end', 'build-test', 'grade', 'week-end']);
    const dry = await post('schedule', { action: 'register', dryRun: true });
    expect(dry.status).toBe(200);
    expect((dry.body.lines as string[])[0]).toContain('run-job ingest');
    expect(dry.body.status).toBeNull();
    expect((await post('runJobNow', { job: 'nope' })).status).toBe(400);
  });

  it('refuses setup calls from other devices', async () => {
    const ip = lanAddresses()[0];
    if (!ip) return; // no network adapter here
    const r = await fetch(`http://${ip}:${PORT}/api/study/setupVault`, { method: 'POST', headers: { 'X-EOS-PIN': hub.pin }, body: JSON.stringify({ path: join(dir, 'evil') }) });
    expect(r.status).toBe(403);
    expect(existsSync(join(dir, 'evil'))).toBe(false);
  });

  it('keeps the app and the stand-alone script on the same task table', async () => {
    const mod = (await import(pathToFileURL(join(process.cwd(), 'scripts', 'study-schedule.mjs')).href)) as { TASKS: typeof TASKS; taskCommands: (v: string) => { args: string[] }[] };
    expect(mod.TASKS.map(({ name, job, schedule }) => ({ name, job, schedule }))).toEqual(TASKS.map(({ name, job, schedule }) => ({ name, job, schedule })));
    expect(mod.taskCommands('C:\\Study Vault').map((t) => t.args)).toEqual(taskArgs('C:\\Study Vault').map((t) => t.args));
  });
});
