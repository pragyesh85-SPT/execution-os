import { describe, expect, it } from 'vitest';
import { emptyDoc } from '../src/core/defaults';
import { liveBlocks, planFor } from '../src/core/engine';
import { makeImportProposal, type ImportEvent } from '../src/core/imports';
import { checkJoinLink } from '../src/core/links';
import { addProposal, applyProposal } from '../src/core/proposals';
import type { Doc } from '../src/core/types';

const NOW = new Date(2026, 9, 4, 20).getTime(); // Sunday evening, importing next week
const run = <R>(d: Doc, op: (d: Doc, now: number) => R) => op(d, NOW);

const classes: ImportEvent[] = [
  { externalId: 'msg1:2026-10-05', title: 'Probability L7', date: '2026-10-05', start: '14:00', end: '15:30', joinUrl: 'https://iitj.zoom.us/j/123' },
  { externalId: 'msg1:2026-10-07', title: 'Probability L8', date: '2026-10-07', start: '14:00', end: '15:30', joinUrl: 'https://iitj.zoom.us/j/123' },
  { externalId: 'msg2:2026-10-06', title: 'ML lab', date: '2026-10-06', start: '16:00', end: '17:00', joinUrl: 'https://meet.google.com/abc-defg-hij' },
];

function importAndApply(d: Doc, events: ImportEvent[]) {
  const { proposal, result } = makeImportProposal(d, events, NOW);
  if (proposal) {
    run(d, addProposal(proposal));
    run(d, applyProposal(proposal.id, 'week'));
  }
  return { proposal, result };
}

const imported = (d: Doc, date: string) => liveBlocks(planFor(d, date)).filter((b) => b.source === 'import');

describe('imports', () => {
  it('creates pinned blocks with Join links and reminders, as one proposal', () => {
    const d = emptyDoc();
    const { proposal, result } = importAndApply(d, classes);
    expect(proposal?.kind).toBe('import');
    expect(proposal?.title).toBe('3 classes found');
    expect(result.added).toBe(3);
    const b = imported(d, '2026-10-05')[0];
    expect(b).toMatchObject({ title: 'Probability L7', pinned: true, fixed: true, joinUrl: 'https://iitj.zoom.us/j/123', reminderMin: 10, externalId: 'msg1:2026-10-05', category: 'iit' });
  });

  it('importing the same week twice yields zero duplicates', () => {
    const d = emptyDoc();
    importAndApply(d, classes);
    const again = importAndApply(d, classes);
    expect(again.proposal).toBeNull();
    expect(again.result.unchanged).toBe(3);
    for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) expect(imported(d, date)).toHaveLength(1);
  });

  it('a changed time updates the same block and is listed as changed', () => {
    const d = emptyDoc();
    importAndApply(d, classes);
    const before = imported(d, '2026-10-05')[0];
    const moved = classes.map((c) => (c.externalId === 'msg1:2026-10-05' ? { ...c, start: '15:00', end: '16:30' } : c));
    const { proposal, result } = importAndApply(d, moved);
    expect(result.changed).toBe(1);
    expect(proposal?.days[0].lines[0].reason).toMatch(/Changed "Probability L7" 14:00–15:30 → 15:00–16:30/);
    const after = imported(d, '2026-10-05');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].s).toBe((15 - 4) * 60);
  });

  it('reports a clash with an anchor instead of forcing it, and drops non-https links', () => {
    const d = emptyDoc();
    const { result } = importAndApply(d, [
      { externalId: 'x1', title: 'Late seminar', date: '2026-10-05', start: '20:30', end: '22:00' },
      { externalId: 'x2', title: 'Odd link', date: '2026-10-05', start: '10:00', end: '11:00', joinUrl: 'http://example.com/meet' },
    ]);
    expect(result.skipped.join(' ')).toMatch(/Late seminar.*overlaps the anchor "Sleep"/);
    expect(result.skipped.join(' ')).toMatch(/not https/);
    expect(imported(d, '2026-10-05').map((b) => b.title)).toEqual(['Odd link']);
    expect(imported(d, '2026-10-05')[0].joinUrl).toBeUndefined();
  });
});

describe('join link safety', () => {
  const s = { joinDomains: ['classes.example.edu'] };
  it('one-tap Join only for https links on the allow-list', () => {
    expect(checkJoinLink('https://zoom.us/j/1', s)?.ok).toBe(true);
    expect(checkJoinLink('https://iitj.zoom.us/j/1', s)?.ok).toBe(true);
    expect(checkJoinLink('https://meet.google.com/x', s)?.ok).toBe(true);
    expect(checkJoinLink('https://classes.example.edu/live', s)?.ok).toBe(true);
    expect(checkJoinLink('https://evilzoom.us/j/1', s)).toMatchObject({ ok: false, domain: 'evilzoom.us' });
    expect(checkJoinLink('https://zoom.us.evil.com/j/1', s)?.ok).toBe(false);
    expect(checkJoinLink('http://zoom.us/j/1', s)).toMatchObject({ ok: false, https: false });
    expect(checkJoinLink(undefined, s)).toBeNull();
  });
});
