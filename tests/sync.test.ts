import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/defaults';
import { pendingKeys, planSync, threeWay, type Conflict } from '../src/core/sync';
import type { Doc, Task } from '../src/core/types';

const task = (id: string, title: string, u: number, r?: number, extra: Partial<Task> = {}): Task => ({
  id,
  u,
  r,
  title,
  area: 'iit',
  priority: 2,
  done: false,
  createdAt: 1,
  ...extra,
});

function trio() {
  const synced = emptyDoc();
  synced.tasks.t1 = task('t1', 'Assignment 3', 10, 5);
  const local: Doc = structuredClone(synced);
  const remote: Doc = structuredClone(synced);
  return { synced, local, remote };
}

const none = new Map<string, Conflict>();

describe('sync plan', () => {
  it('uploads an edit made offline on this device', () => {
    const { synced, local, remote } = trio();
    local.tasks.t1 = { ...local.tasks.t1, done: true, u: 20 };
    const p = planSync(synced, local, remote, none, 0);
    expect(p.push).toHaveLength(1);
    expect(p.push[0]).toMatchObject({ col: 'tasks', id: 't1', baseR: 5 });
    expect(p.conflicts).toHaveLength(0);
  });

  it('takes an edit made on the PC', () => {
    const { synced, local, remote } = trio();
    remote.tasks.t1 = { ...remote.tasks.t1, title: 'Assignment 3 (Q1-Q5)', u: 30, r: 9 };
    const p = planSync(synced, local, remote, none, 0);
    expect(p.local.tasks.t1.title).toBe('Assignment 3 (Q1-Q5)');
    expect(p.push).toHaveLength(0);
  });

  it('merges silently when the two devices changed different fields', () => {
    const { synced, local, remote } = trio();
    local.tasks.t1 = { ...local.tasks.t1, done: true, u: 20 };
    remote.tasks.t1 = { ...remote.tasks.t1, title: 'Assignment 3 (Q1-Q5)', u: 30, r: 9 };
    const p = planSync(synced, local, remote, none, 0);
    expect(p.conflicts).toHaveLength(0);
    expect(p.local.tasks.t1).toMatchObject({ done: true, title: 'Assignment 3 (Q1-Q5)', r: 9 });
    expect(p.push[0]).toMatchObject({ baseR: 9 });
  });

  it('asks the user when the same field was changed differently on both', () => {
    const { synced, local, remote } = trio();
    local.tasks.t1 = { ...local.tasks.t1, title: 'Phone title', u: 20 };
    remote.tasks.t1 = { ...remote.tasks.t1, title: 'PC title', u: 30, r: 9 };
    const p = planSync(synced, local, remote, none, 0);
    expect(p.conflicts).toHaveLength(1);
    expect(p.conflicts[0].fields).toEqual(['title']);
    expect(p.local.tasks.t1.title).toBe('Phone title'); // nothing overwritten until the user decides
    expect(p.push).toHaveLength(0);
  });

  it('does not upload a record that is waiting for a decision', () => {
    const { synced, local, remote } = trio();
    local.tasks.t1 = { ...local.tasks.t1, title: 'Phone title', u: 20 };
    const open = new Map<string, Conflict>([['tasks/t1', { key: 'tasks/t1', col: 'tasks', id: 't1', base: null, mine: local.tasks.t1, theirs: remote.tasks.t1, fields: ['title'], at: 0 }]]);
    const p = planSync(synced, local, remote, open, 0);
    expect(p.push).toHaveLength(0);
    expect(pendingKeys(synced, local, open)).toHaveLength(0);
  });

  it('treats identical edits on both sides as no conflict', () => {
    const { synced, local, remote } = trio();
    local.tasks.t1 = { ...local.tasks.t1, done: true, u: 20 };
    remote.tasks.t1 = { ...remote.tasks.t1, done: true, u: 25, r: 9 };
    const p = planSync(synced, local, remote, none, 0);
    expect(p.conflicts).toHaveLength(0);
    expect(p.push).toHaveLength(0);
    expect(p.local.tasks.t1.r).toBe(9);
  });

  it('a brand-new phone adopts the PC data instead of fighting it with defaults', () => {
    const phone = emptyDoc(); // untouched defaults, u = 0
    const pc = emptyDoc();
    pc.settings = { ...pc.settings, name: 'PJ', onboarded: true, u: 50, r: 3 };
    pc.tasks.t9 = task('t9', 'From PC', 40, 4);
    const p = planSync(emptyDoc(), phone, pc, none, 0);
    expect(p.conflicts).toHaveLength(0);
    expect(p.local.settings.name).toBe('PJ');
    expect(p.local.tasks.t9.title).toBe('From PC');
    expect(p.push).toHaveLength(0);
  });

  it('merges a day plan edited on two devices (missions vs outcomes)', () => {
    const synced = emptyDoc();
    const local = emptyDoc();
    const remote = emptyDoc();
    const base = { id: '2026-10-07', u: 1, blocks: [], missions: {}, outcomes: [] };
    local.days['2026-10-07'] = { ...base, u: 5, missions: { 'b-iit': { title: 'Submit A3', steps: [] } } };
    remote.days['2026-10-07'] = { ...base, u: 6, r: 7, outcomes: [{ id: 'o1', text: 'Ship onboarding', area: 'founder', done: false }] };
    const p = planSync(synced, local, remote, none, 0);
    expect(p.conflicts).toHaveLength(0);
    expect(p.local.days['2026-10-07'].missions['b-iit'].title).toBe('Submit A3');
    expect(p.local.days['2026-10-07'].outcomes).toHaveLength(1);
  });

  it('counts offline changes waiting for the PC', () => {
    const { synced, local } = trio();
    local.tasks.t2 = task('t2', 'New while offline', 99);
    local.tasks.t1 = { ...local.tasks.t1, done: true, u: 20 };
    expect(pendingKeys(synced, local, none).sort()).toEqual(['tasks/t1', 'tasks/t2']);
  });

  it('three-way merge reports the clashing field path', () => {
    const base = task('t', 'a', 1, 1, { notes: 'x' });
    const mine: Task = { ...base, notes: 'phone', u: 2 };
    const theirs: Task = { ...base, notes: 'pc', u: 3, r: 2 };
    const r = threeWay(base, mine, theirs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields).toEqual(['notes']);
  });
});
