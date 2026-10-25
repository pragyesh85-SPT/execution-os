import { describe, expect, it } from 'vitest';
import { checkForUpdates, newer } from '../src/lib/updates';

const release = (tag: string) =>
  (async () =>
    new Response(
      JSON.stringify({ tag_name: tag, html_url: 'https://github.com/pragyesh85-SPT/execution-os/releases/tag/' + tag, assets: [{ name: `ExecutionOS-${tag.slice(1)}.apk`, browser_download_url: 'https://example.com/app.apk' }] }),
      { status: 200 },
    )) as unknown as typeof fetch;

describe('updates', () => {
  it('compares versions numerically, pre-releases below the release', () => {
    expect(newer('2.0.0', '1.5.0')).toBe(true);
    expect(newer('1.10.0', '1.9.3')).toBe(true);
    expect(newer('1.5.0', '1.5.0')).toBe(false);
    expect(newer('2.0.0', '2.0.0-beta.1')).toBe(true);
    expect(newer('2.0.0-beta.1', '2.0.0')).toBe(false);
  });

  it('finds a newer GitHub release, and says so when there is none', async () => {
    expect(await checkForUpdates('1.5.0', release('v2.0.0'))).toMatchObject({ available: true, latest: '2.0.0' });
    expect(await checkForUpdates('2.0.0', release('v2.0.0'))).toMatchObject({ available: false });
  });

  it('fails gracefully offline', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const r = await checkForUpdates('2.0.0', offline);
    expect(r.available).toBe(false);
    expect(r.error).toMatch(/offline|Could not check/);
  });
});
