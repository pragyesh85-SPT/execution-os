import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initVault, layout } from '../server/study/vault';

// Shared by the Study OS tests: a fresh vault in the temp folder, set up with the synthetic sample
// subject in tests/fixtures/study-sample (never the real vault, never real course material).

export const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'study-sample');

export function sampleVault(prefix = 'eos-study-'): { root: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const root = join(dir, 'vault');
  initVault(root, { git: false, today: '2026-10-28' });
  const L = layout(root);
  cpSync(join(FIXTURE, 'assessment.yaml'), L.assessment);
  mkdirSync(join(L.subject('dprob')), { recursive: true });
  cpSync(join(FIXTURE, 'syllabus', 'dprob.md'), join(L.subject('dprob'), 'syllabus.md'));
  return { root, dir };
}

/** What the headless jobs (/ingest, /curate, /packs, /labs) would have written. */
export function claudeWrites(root: string) {
  const L = layout(root);
  for (const s of ['demo', 'dprob']) cpSync(join(FIXTURE, 'claude', s), L.subject(s), { recursive: true });
  // the transcripts /curate fetched with `study transcript` (synthetic), which back the fixture's segment times
  cpSync(join(FIXTURE, 'cache'), join(root, 'cache'), { recursive: true });
}

export const at = (y: number, mo: number, d: number, h = 10, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
