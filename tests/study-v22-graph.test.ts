import { afterAll, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { StudyService } from '../server/study/service';
import { COL_W, layoutGraph } from '../src/core/study/graph';
import type { BankQuestion, Concept } from '../src/core/study/types';
import { claudeWrites, sampleVault } from './study-helpers';

// v2.2 phase 4: a drawn concept graph per subject.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const c = (id: string, order: number, extra: Partial<Concept> = {}): Concept => ({ id, subject: 's', title: id.toUpperCase(), order, status: 'ready', released: true, examWeight: 1, minutes: 30, prereqs: [], confusedWith: [], testedBy: [], formulas: [], sources: [], notation: [], file: '', ...extra });

describe('concept graph layout', () => {
  it('puts each concept one column right of its deepest prerequisite, questions last, and survives cycles', () => {
    const cs = [c('a', 1), c('b', 2, { prereqs: ['a'] }), c('c', 3, { prereqs: ['a', 'b'], confusedWith: ['d'] }), c('d', 4), c('x', 5, { subject: 'other' }), c('m', 6, { mergedInto: 'a' }), c('p', 7, { prereqs: ['q'] }), c('q', 8, { prereqs: ['p'] })];
    const qs = [{ id: 'q1', subject: 's', concepts: ['c'], kind: 'numerical' } as BankQuestion, { id: 'q2', subject: 'other', concepts: ['x'] } as BankQuestion];
    const g = layoutGraph('s', cs, (id) => (id === 'a' ? 'applied' : 'none'), qs);
    const col = (id: string) => g.nodes.find((n) => n.id === id)?.col;
    expect(col('a')).toBe(0);
    expect(col('b')).toBe(1);
    expect(col('c')).toBe(2); // the deepest prerequisite decides
    expect(col('d')).toBe(0);
    expect(g.nodes.find((n) => n.id === 'q1')).toMatchObject({ kind: 'question', col: 3, x: 30 + 3 * COL_W });
    expect(g.nodes.map((n) => n.id)).not.toContain('x'); // other subject
    expect(g.nodes.map((n) => n.id)).not.toContain('m'); // merged duplicate
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['p', 'q'])); // a cycle is drawn, not an infinite loop
    expect(g.edges).toEqual(expect.arrayContaining([{ from: 'a', to: 'b', kind: 'prereq' }, { from: 'b', to: 'c', kind: 'prereq' }, { from: 'c', to: 'd', kind: 'confused' }, { from: 'c', to: 'q1', kind: 'tested' }]));
    expect(g.nodes.find((n) => n.id === 'a')?.rung).toBe('applied');
    expect(g.width).toBeGreaterThan(3 * COL_W);
  });

  it('is served per subject from the vault', () => {
    const v = sampleVault('eos-v22d-');
    dirs.push(v.dir);
    claudeWrites(v.root);
    const svc = new StudyService({ vault: v.root });
    const g = svc.graph({ subject: 'demo' });
    expect(g.nodes.find((n) => n.id === 'demo-dot-product')?.col).toBe(1);
    expect(g.edges).toContainEqual({ from: 'demo-vectors-and-linear-combinations', to: 'demo-dot-product', kind: 'prereq' });
    expect(g.edges.filter((e) => e.kind === 'tested').length).toBeGreaterThanOrEqual(4);
    expect(() => svc.graph({ subject: 'nope' })).toThrow(/Unknown subject/);
    svc.close();
  });
});
