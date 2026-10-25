import { describe, expect, it } from 'vitest';
import { githubForBlock } from '../server/mcp/github';
import { emptyDoc } from '../src/core/defaults';
import { goalActual, upsertGoal } from '../src/core/goals';
import * as ops from '../src/core/ops';
import type { Doc } from '../src/core/types';
import { summarizeEvents, type GhEvent } from '../src/lib/github';

const DATE = '2026-10-07';
const NOW = new Date(2026, 9, 7, 13).getTime();
const run = <R>(d: Doc, op: (d: Doc, now: number) => R) => op(d, NOW);

function doc() {
  const d = emptyDoc();
  d.settings.onboarded = true;
  return d;
}

describe('guided logging', () => {
  it('a log through Claude has the same shape as an in-app log (only loggedVia differs)', () => {
    const a = doc();
    const b = doc();
    const log = { date: DATE, blockId: 'b-iit', status: 'partial' as const, percent: 60, note: 'Q1–Q3 done', links: ['https://example.com/a3'], remaining: 'Q4, Q5', blockers: 'none', confirmed: true };
    run(a, ops.logSession({ ...log, via: 'app', replace: true }));
    run(b, ops.logSession({ ...log, via: 'mcp' }));
    const strip = (d: Doc) => {
      const { loggedVia: _v, u: _u, at: _a, ...rest } = d.proofs[`${DATE}:b-iit`];
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
    expect(a.proofs[`${DATE}:b-iit`].loggedVia).toBe('app');
    expect(b.proofs[`${DATE}:b-iit`].loggedVia).toBe('mcp');
  });

  it('remaining work becomes one inbox task with the mission, area and target; logging again does not duplicate it', () => {
    const d = doc();
    const g = run(d, upsertGoal({ level: 'week', period: '2026-10-05', title: '3 assignments', area: 'iit', metric: { kind: 'count', unit: 'assignments' }, target: 3 }));
    run(d, ops.setMission(DATE, 'b-iit', { title: 'Assignment 3', steps: [], goalId: g }));
    run(d, ops.logSession({ date: DATE, blockId: 'b-iit', status: 'partial', note: 'half', links: [], remaining: 'Q4 and Q5', via: 'mcp', confirmed: true }));
    run(d, ops.logSession({ date: DATE, blockId: 'b-iit', status: 'partial', note: 'still half', links: [], remaining: 'Q4 and Q5', via: 'mcp', confirmed: true }));
    const tasks = Object.values(d.tasks).filter((t) => t.title === 'Continue: Assignment 3');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ area: 'iit', priority: 2, goalId: g, notes: 'Q4 and Q5' });
    expect(d.proofs[`${DATE}:b-iit`].note).toBe('half\nstill half'); // Claude appends to an existing log
    expect(d.proofs[`${DATE}:b-iit`].goalId).toBe(g);
    run(d, ops.logSession({ date: DATE, blockId: 'b-iit', status: 'done', note: 'finished', links: [], via: 'app', replace: true }));
    expect(d.proofs[`${DATE}:b-iit`].note).toBe('finished'); // the in-app sheet edits in place
    expect(d.proofs[`${DATE}:b-iit`].percent).toBeUndefined();
    expect(goalActual(d, d.goals[g], NOW).actual).toBe(1);
  });

  it('refuses a block that does not exist', () => {
    expect(() => run(doc(), ops.logSession({ date: DATE, blockId: 'nope', status: 'done', note: '', links: [], via: 'mcp' }))).toThrow(/get_day/);
  });
});

describe('GitHub activity', () => {
  const events: GhEvent[] = [
    { type: 'PushEvent', created_at: new Date(NOW - 30 * 60_000).toISOString(), repo: { name: 'pj/execution-os' }, payload: { size: 3, commits: [{ message: 'feat: pins\n\nbody' }, { message: 'fix: x' }, { message: 'test: y' }] } },
    { type: 'PullRequestEvent', created_at: new Date(NOW - 20 * 60_000).toISOString(), repo: { name: 'pj/execution-os' }, payload: { action: 'closed', number: 218, pull_request: { merged: true, title: 'Pins' } } },
    { type: 'PushEvent', created_at: new Date(NOW - 5 * 3_600_000).toISOString(), repo: { name: 'pj/old' }, payload: { size: 9 } },
  ];
  it('summarises commits and PRs inside the block window only', () => {
    const s = summarizeEvents(events, NOW - 3_600_000, NOW);
    expect(s.lines).toEqual(['3 commits to execution-os', 'PR #218 merged']);
    expect(s.commits[0].messages[0]).toBe('feat: pins');
  });

  it('the hub uses the public API once per block and caches the answer', async () => {
    const d = doc();
    d.settings.githubUser = 'pj';
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify(events), { status: 200 });
    }) as unknown as typeof fetch;
    const a = await githubForBlock(d, NOW - 3_600_000, NOW, 'k1', fake);
    const b = await githubForBlock(d, NOW - 3_600_000, NOW, 'k1', fake);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
    expect((a as { lines: string[] }).lines).toContain('PR #218 merged');
    const none = await githubForBlock(doc(), 0, 1, 'k2', fake);
    expect(none).toHaveProperty('note');
  });
});
