import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { checkFrame, clearFrameCache, embeddable, type HeadFetcher } from '../server/study/frames';
import { StudyService } from '../server/study/service';
import { claudeWrites, sampleVault } from './study-helpers';

// v2.2 phase 3: non-YouTube resources open inside the Study tab when the site allows it.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => clearFrameCache());

describe('can a page be shown inside the app?', () => {
  it('reads X-Frame-Options and CSP frame-ancestors', () => {
    expect(embeddable({})).toMatchObject({ embeddable: true, pdf: false });
    expect(embeddable({ 'x-frame-options': 'DENY' })).toMatchObject({ embeddable: false, reason: expect.stringContaining('DENY') });
    expect(embeddable({ 'x-frame-options': 'sameorigin' }).embeddable).toBe(false);
    expect(embeddable({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self' https://ocw.mit.edu" }).embeddable).toBe(false);
    expect(embeddable({ 'content-security-policy': "frame-ancestors 'none'" }).embeddable).toBe(false);
    expect(embeddable({ 'content-security-policy': 'frame-ancestors *' }).embeddable).toBe(true);
    expect(embeddable({ 'content-security-policy': "default-src 'self'" }).embeddable).toBe(true); // no frame-ancestors = allowed
    expect(embeddable({ 'content-type': 'application/pdf' })).toMatchObject({ embeddable: true, pdf: true });
  });

  it('checks once a day per link and survives unreachable sites', async () => {
    let calls = 0;
    const f: HeadFetcher = async () => (calls++, { ok: true, status: 200, headers: { 'x-frame-options': 'DENY' } });
    expect((await checkFrame('https://a.example/x', f, 1000)).embeddable).toBe(false);
    await checkFrame('https://a.example/x', f, 2000);
    expect(calls).toBe(1);
    await checkFrame('https://a.example/x', f, 1000 + 86_400_001);
    expect(calls).toBe(2);
    const down: HeadFetcher = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await checkFrame('https://b.example/y', down)).toMatchObject({ embeddable: false, reason: expect.stringContaining('could not reach') });
    expect(await checkFrame('https://c.example/z', async () => ({ ok: false, status: 404, headers: {} }))).toMatchObject({ embeddable: false, reason: 'the site answered 404' });
  });

  it('only checks links that are in the study paths (no arbitrary fetches through the hub)', async () => {
    const v = sampleVault('eos-v22c-');
    dirs.push(v.dir);
    claudeWrites(v.root);
    const svc = new StudyService({ vault: v.root });
    const ok: HeadFetcher = async () => ({ ok: true, status: 200, headers: {} });
    expect(await svc.frameCheck({ url: 'https://seeing-theory.brown.edu/compound-probability/index.html', fetcher: ok })).toMatchObject({ embeddable: true });
    await expect(svc.frameCheck({ url: 'http://192.168.1.1/admin', fetcher: ok })).rejects.toThrow(/Only resources from your study paths/);
    svc.close();
  });
});
