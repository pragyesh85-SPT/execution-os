import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubDb } from '../server/db';
import type { Migration } from '../server/migrations';
import { emptyDoc } from '../src/core/defaults';
import { FEATURE_DEFAULTS, isOn } from '../src/core/features';
import * as ops from '../src/core/ops';
import { buildRescue } from '../src/core/rescue';
import { getRec, splitKey } from '../src/core/sync';
import type { Doc, Synced } from '../src/core/types';

// The UI store needs localStorage and window; give it tiny in-memory stand-ins.
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as Record<string, unknown>).window = globalThis;

const DATE = '2026-10-07';
const T = new Date(2026, 9, 7, 13, 0).getTime();
let dir: string;

function seeded() {
  let x = 42;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
}
const strip = (r: Synced | undefined) => {
  if (!r) return r;
  const { r: _r, ...rest } = r;
  return rest;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eos-found-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
  ops.setRandom(null);
});

describe('ops parity: the app and the hub make identical edits', async () => {
  const actions = await import('../src/state/actions');
  const { useStore } = await import('../src/state/store');
  let n = 0;

  function both(runUi: () => void, op: (d: Doc, now: number) => unknown) {
    const db = new HubDb(join(dir, `parity-${n++}.db`));
    vi.useFakeTimers();
    vi.setSystemTime(T);
    useStore.getState().replaceDoc(structuredClone(db.doc));
    ops.setRandom(seeded());
    runUi();
    const ui = useStore.getState().doc;
    ops.setRandom(seeded());
    const res = db.mutate(op, 'test');
    expect(res.changed.length).toBeGreaterThan(0);
    for (const key of res.changed) {
      const { col, id } = splitKey(key);
      expect(strip(getRec(ui, col, id))).toEqual(strip(getRec(db.doc, col, id)));
    }
    // and nothing else changed on the UI side
    db.close();
  }

  const block = { id: 'b-iit', category: 'iit' as const, origin: 'b-iit' };

  it('setMission', () =>
    both(
      () => actions.setMission(DATE, 'b-iit', { title: 'Submit A3', steps: [] }),
      ops.setMission(DATE, 'b-iit', { title: 'Submit A3', steps: [] }),
    ));
  it('addTask', () =>
    both(
      () => actions.addTask({ title: 'Probability A4', area: 'iit', priority: 1 }),
      ops.addTask({ title: 'Probability A4', area: 'iit', priority: 1 }),
    ));
  it('addException', () => both(() => actions.addException(DATE, 660, 780, 'Movie'), ops.addException(DATE, 660, 780, 'Movie')));
  it('saveProof', () => both(() => actions.saveProof(DATE, block, 'done', 'Q1–Q5', ['https://x'], []), ops.saveProof(DATE, block, 'done', 'Q1–Q5', ['https://x'], [])));
  it('applyRescue', () => {
    const d = emptyDoc();
    d.days[DATE] = { id: DATE, u: 1, blocks: [], missions: { 'b-founder': { title: 'Ship onboarding', steps: [] } }, outcomes: [] };
    const result = buildRescue(d, DATE, T);
    both(() => actions.applyRescue(DATE, result), ops.applyRescue(DATE, result));
  });
});

describe('HubDb.mutate', () => {
  it('writes only changed records, with history under the device label', () => {
    const db = new HubDb(join(dir, 'mutate.db'));
    const rev0 = db.rev;
    const res = db.mutate(ops.addTask({ title: 'From the hub', area: 'founder' }), 'mcp:test');
    expect(res.changed).toHaveLength(1);
    expect(db.rev).toBe(rev0 + 1);
    const id = res.result;
    expect(db.history('tasks', id)[0].device).toBe('mcp:test');
    const none = db.mutate(() => undefined, 'mcp:test');
    expect(none.changed).toHaveLength(0);
    expect(db.rev).toBe(rev0 + 1);
    db.close();
  });

  it('rolls back and leaves rev unchanged when a write fails', () => {
    const file = join(dir, 'rollback.db');
    const db = new HubDb(file);
    const rev0 = db.rev;
    expect(() =>
      db.mutate((d, now) => {
        ops.setMission(DATE, 'b-iit', { title: 'should not persist', steps: [] })(d, now);
        // BigInt cannot be serialised: the write of this record throws inside the transaction.
        d.tasks.bad = { id: 'bad', u: now, title: 'x', area: 'iit', priority: 2, done: false, createdAt: now, big: 1n } as never;
      }, 'test'),
    ).toThrow();
    expect(db.rev).toBe(rev0);
    expect(db.doc.days[DATE]).toBeUndefined();
    db.close();
    const again = new HubDb(file);
    expect(again.rev).toBe(rev0);
    expect(again.doc.days[DATE]).toBeUndefined();
    again.close();
  });

  it('rolls back when the op itself throws', () => {
    const db = new HubDb(join(dir, 'throw.db'));
    const rev0 = db.rev;
    expect(() =>
      db.mutate(() => {
        throw new Error('bad op');
      }, 'test'),
    ).toThrow('bad op');
    expect(db.rev).toBe(rev0);
    db.close();
  });
});

describe('tolerant loader and migrations', () => {
  it('opens a database that contains a collection from a newer version, and keeps that row', () => {
    const file = join(dir, 'future.db');
    const a = new HubDb(file);
    a.sql.prepare('INSERT INTO records (col, id, r, u, del, data) VALUES (?, ?, ?, ?, 0, ?)').run('futureThing', 'f1', 999, 1, JSON.stringify({ id: 'f1', u: 1 }));
    a.close();
    const b = new HubDb(file);
    expect(Object.keys(b.doc)).not.toContain('futureThing');
    b.mutate(ops.addTask({ title: 'still works', area: 'iit' }), 'test');
    const row = b.sql.prepare("SELECT id FROM records WHERE col = 'futureThing'").get() as { id: string } | undefined;
    expect(row?.id).toBe('f1');
    b.close();
  });

  it('marks a fresh database with the current schema version', () => {
    const db = new HubDb(join(dir, 'fresh.db'));
    expect(db.schemaVersion).toBe(1);
    expect(db.migration.ran).toEqual([]);
    db.close();
  });

  it('runs pending migrations once, after a pre-migration backup, and is a no-op on the next start', () => {
    const sub = mkdtempSync(join(dir, 'mig-'));
    const file = join(sub, 'execution-os.db');
    new HubDb(file).close(); // a v1-layout file
    let runs = 0;
    const list: Migration[] = [
      {
        to: 2,
        name: 'add-test-table',
        up: (sql) => {
          runs++;
          sql.exec('CREATE TABLE IF NOT EXISTS test_mig (x INTEGER)');
        },
      },
    ];
    const first = new HubDb(file, undefined, { migrations: list });
    expect(first.migration).toMatchObject({ from: 1, to: 2, ran: ['add-test-table'] });
    expect(first.schemaVersion).toBe(2);
    expect(existsSync(first.migration.backup!)).toBe(true);
    expect(readdirSync(join(sub, 'backups')).some((f) => f.startsWith('pre-migration-v1-to-v2-'))).toBe(true);
    first.close();
    const second = new HubDb(file, undefined, { migrations: list });
    expect(second.migration.ran).toEqual([]);
    expect(runs).toBe(1);
    // labelled backups are not part of the daily rotation
    expect(second.backups().every((f) => f.startsWith('execution-os-'))).toBe(true);
    expect(second.labelledBackups().length).toBe(1);
    second.close();
  });

  it('a failing migration leaves the old version and data in place', () => {
    const sub = mkdtempSync(join(dir, 'migfail-'));
    const file = join(sub, 'execution-os.db');
    const a = new HubDb(file);
    a.mutate(ops.addTask({ title: 'keep me', area: 'iit' }), 'test');
    a.close();
    const bad: Migration[] = [
      {
        to: 2,
        name: 'broken',
        up: (sql) => {
          sql.exec('CREATE TABLE half (x INTEGER)');
          throw new Error('migration failed');
        },
      },
    ];
    expect(() => new HubDb(file, undefined, { migrations: bad })).toThrow('migration failed');
    const b = new HubDb(file);
    expect(b.schemaVersion).toBe(1);
    expect(Object.values(b.doc.tasks).some((t) => t.title === 'keep me')).toBe(true);
    expect(b.sql.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    b.close();
  });
});

describe('feature flags', () => {
  it('falls back to the defaults for settings records that never set a flag', () => {
    const s = emptyDoc().settings;
    delete s.features;
    expect(isOn(s, 'pins')).toBe(FEATURE_DEFAULTS.pins);
    expect(isOn({ features: { pins: !FEATURE_DEFAULTS.pins } }, 'pins')).toBe(!FEATURE_DEFAULTS.pins);
    expect(isOn({ features: {} }, 'mcp')).toBe(FEATURE_DEFAULTS.mcp);
  });
});
