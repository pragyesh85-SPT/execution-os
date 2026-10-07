import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubDb } from '../server/db';
import { lanAddresses, startHub, type Hub } from '../server/hub';
import { emptyDoc } from '../src/core/defaults';
import type { Change } from '../src/core/sync';
import type { Task } from '../src/core/types';

const PORT = 47991;
let hub: Hub;
let dir: string;
const base = `http://127.0.0.1:${PORT}`;
const json = { 'Content-Type': 'application/json' };

const task = (id: string, title: string, u: number): Task => ({ id, u, title, area: 'iit', priority: 1, done: false, createdAt: u });

async function pull() {
  return (await (await fetch(`${base}/api/sync?rev=-1`)).json()) as { rev: number; doc: ReturnType<typeof emptyDoc> };
}
async function push(changes: Change[], device = 'test') {
  return (await (
    await fetch(`${base}/api/sync/push`, { method: 'POST', headers: { ...json, 'X-EOS-DEVICE': device }, body: JSON.stringify({ changes }) })
  ).json()) as { rev: number; accepted: number; rejected: { col: string; id: string }[]; doc: ReturnType<typeof emptyDoc> };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eos-hub-'));
  hub = await startHub({ port: PORT, dbFile: join(dir, 'execution-os.db'), distDir: join(dir, 'dist') });
});

afterAll(async () => {
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hub (PC database)', () => {
  it('answers ping and focus, and made a first backup', async () => {
    const ping = await (await fetch(`${base}/api/ping`)).json();
    expect(ping.app).toBe('execution-os');
    const focus = await (await fetch(`${base}/api/focus`)).json();
    expect(Array.isArray(focus.blocked)).toBe(true);
    expect(readdirSync(join(dir, 'backups')).length).toBe(1);
  });

  it('saves a new record from a device and stamps it with a hub revision', async () => {
    const out = await push([{ col: 'tasks', id: 't1', baseR: 0, record: task('t1', 'From phone', 100) }], 'Android');
    expect(out.accepted).toBe(1);
    expect(out.doc.tasks.t1.r).toBe(out.rev);
  });

  it('refuses an edit based on an old version (another device changed it first)', async () => {
    const { doc } = await pull();
    const r1 = doc.tasks.t1.r!;
    const pc = await push([{ col: 'tasks', id: 't1', baseR: r1, record: { ...doc.tasks.t1, title: 'Edited on PC', u: 200 } as Task }], 'PC');
    expect(pc.accepted).toBe(1);
    const phone = await push([{ col: 'tasks', id: 't1', baseR: r1, record: { ...doc.tasks.t1, title: 'Edited on phone', u: 300 } as Task }], 'Android');
    expect(phone.accepted).toBe(0);
    expect(phone.rejected).toEqual([{ col: 'tasks', id: 't1' }]);
    expect(phone.doc.tasks.t1.title).toBe('Edited on PC');
  });

  it('keeps every version in history with the device that sent it', () => {
    const h = hub.db.history('tasks', 't1');
    expect(h.map((x) => x.device)).toEqual(['PC', 'Android']);
    expect(h[1].data).toMatchObject({ title: 'From phone' });
  });

  it('stores links saved from the browser extension', async () => {
    await fetch(`${base}/api/later`, { method: 'POST', headers: json, body: JSON.stringify({ url: 'https://youtube.com/watch?v=x', title: 'video' }) });
    const { doc } = await pull();
    expect(Object.values(doc.later).some((l) => l.url === 'https://youtube.com/watch?v=x')).toBe(true);
  });

  it('requires the pairing PIN from other devices on the network', async () => {
    const ip = lanAddresses()[0];
    if (!ip) return; // no network adapter in this environment
    const remote = `http://${ip}:${PORT}`;
    expect((await fetch(`${remote}/api/sync`)).status).toBe(401);
    expect((await fetch(`${remote}/api/sync`, { headers: { 'X-EOS-PIN': hub.pin } })).status).toBe(200);
    expect((await fetch(`${remote}/api/info`, { headers: { 'X-EOS-PIN': hub.pin } })).status).toBe(403);
  });
});

describe('database file', () => {
  it('keeps data across restarts', () => {
    const d = mkdtempSync(join(tmpdir(), 'eos-db-'));
    const file = join(d, 'x.db');
    const a = new HubDb(file);
    a.push([{ col: 'tasks', id: 'k', baseR: 0, record: task('k', 'Persist me', 5) }], 'test');
    const pin = a.pin;
    a.close();
    const b = new HubDb(file);
    expect(b.doc.tasks.k.title).toBe('Persist me');
    expect(b.pin).toBe(pin);
    expect(b.rev).toBeGreaterThan(0);
    b.close();
    rmSync(d, { recursive: true, force: true });
  });

  it('imports the old v1 JSON store once and keeps the pairing PIN', () => {
    const d = mkdtempSync(join(tmpdir(), 'eos-mig-'));
    const legacy = join(d, 'execution-os.json');
    const doc = emptyDoc();
    doc.tasks.old = task('old', 'From v1', 9);
    doc.settings = { ...doc.settings, name: 'PJ', u: 4 };
    writeFileSync(legacy, JSON.stringify({ rev: 7, pin: '123456', doc }));
    const db = new HubDb(join(d, 'execution-os.db'), legacy);
    expect(db.doc.tasks.old.title).toBe('From v1');
    expect(db.doc.settings.name).toBe('PJ');
    expect(db.pin).toBe('123456');
    expect(existsSync(legacy)).toBe(false); // renamed to .migrated-*
    db.close();
    rmSync(d, { recursive: true, force: true });
  });
});
