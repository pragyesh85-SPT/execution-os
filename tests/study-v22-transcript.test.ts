import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StudyService } from '../server/study/service';
import { chaptersFromDescription, extractJson, fetchTranscript, parseCaptions, pickTrack, verifySegment, videoIdOf, type Fetcher, type TranscriptCache } from '../server/study/transcript';
import { initVault, MANAGED } from '../server/study/vault';
import { claudeWrites, sampleVault } from './study-helpers';

// v2.2 phase 1: segment times come only from the video's own transcript or chapters.
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ID = 'AbCdEfGhIjK';
const WATCH = `<html><script>var ytInitialPlayerResponse = {"videoDetails":{"title":"Eigen \\"things\\"","lengthSeconds":"600","shortDescription":"Great video\\n0:00 Intro\\n1:30 The idea\\n7:05 Example\\nthanks"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=${ID}&lang=de","languageCode":"de"}]}}};</script><script>ytcfg.set({"INNERTUBE_API_KEY":"KEY123"});</script></html>`;
const XML = '<?xml version="1.0"?><transcript><text start="0.5" dur="4">Hello &amp; welcome</text><text start="90" dur="5.5">An eigenvector keeps its &#39;direction&#39;</text><text start="420.2" dur="3">That&#39;s it</text></transcript>';

function fake(routes: Record<string, string | null>, log: string[] = []): Fetcher {
  return async (url, init) => {
    log.push(`${init?.method ?? 'GET'} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = key ? routes[key] : null;
    return { ok: body !== null, status: body === null ? 404 : 200, text: async () => body ?? '' };
  };
}

describe('transcript parsing', () => {
  it('reads video ids, page JSON, chapters and every caption format', () => {
    expect(videoIdOf('https://www.youtube.com/watch?v=k7RM-ot2NWY&t=3')).toBe('k7RM-ot2NWY');
    expect(videoIdOf('https://youtu.be/k7RM-ot2NWY')).toBe('k7RM-ot2NWY');
    expect(videoIdOf('https://www.youtube.com/embed/k7RM-ot2NWY')).toBe('k7RM-ot2NWY');
    expect(videoIdOf('https://ocw.mit.edu/x')).toBeNull();
    expect(extractJson(WATCH, 'ytInitialPlayerResponse')?.videoDetails).toMatchObject({ title: 'Eigen "things"' });
    expect(chaptersFromDescription('0:00 Intro\n1:30 - The idea\n1:02:05 Example')).toEqual([
      { start: 0, title: 'Intro' },
      { start: 90, title: 'The idea' },
      { start: 3725, title: 'Example' },
    ]);
    expect(chaptersFromDescription('1:30 not from zero\n2:00 b\n3:00 c')).toEqual([]); // YouTube needs 0:00 first
    expect(chaptersFromDescription('0:00 a\n1:00 b')).toEqual([]); // and at least 3
    expect(parseCaptions(XML)).toEqual([
      { start: 0.5, dur: 4, text: 'Hello & welcome' },
      { start: 90, dur: 5.5, text: "An eigenvector keeps its 'direction'" },
      { start: 420.2, dur: 3, text: "That's it" },
    ]);
    expect(parseCaptions('{"events":[{"tStartMs":1000,"dDurationMs":2000,"segs":[{"utf8":"hi "},{"utf8":"there"}]},{"tStartMs":5000}]}')).toEqual([{ start: 1, dur: 2, text: 'hi there' }]);
    expect(parseCaptions('<timedtext><body><p t="1500" d="2500">srv3 <s>line</s></p></body></timedtext>')).toEqual([{ start: 1.5, dur: 2.5, text: 'srv3 line' }]);
    expect(pickTrack([{ baseUrl: 'a', languageCode: 'de' }, { baseUrl: 'b', languageCode: 'en', kind: 'asr' }, { baseUrl: 'c', languageCode: 'en-GB' }])?.baseUrl).toBe('c');
  });

  it("fetches through the Android player API's caption link and falls back to the page", async () => {
    const log: string[] = [];
    const c = await fetchTranscript(`https://youtu.be/${ID}`, fake({ '/watch?v=': WATCH, '/youtubei/v1/player?key=KEY123': JSON.stringify({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'https://yt/tt?lang=en&fmt=srv3', languageCode: 'en' }] } } }), 'https://yt/tt?lang=en': XML }, log));
    expect(c).toMatchObject({ videoId: ID, title: 'Eigen "things"', duration: 600, language: 'en', chapters: [{ start: 0, title: 'Intro' }, { start: 90, title: 'The idea' }, { start: 425, title: 'Example' }] });
    expect(c.transcript).toHaveLength(3);
    expect(log[2]).toBe('GET https://yt/tt?lang=en'); // the srv3 format flag is dropped
    const fallback = await fetchTranscript(`https://youtu.be/${ID}`, fake({ '/watch?v=': WATCH, 'lang=de': XML }));
    expect(fallback.language).toBe('de');
    const noCaptions = WATCH.replace(`"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=${ID}&lang=de","languageCode":"de"}]}}`, '"x":1');
    const none = await fetchTranscript(`https://youtu.be/${ID}`, fake({ '/watch?v=': noCaptions }));
    expect(none).toMatchObject({ transcript: null, error: 'no captions published for this video' });
    expect(none.chapters).toHaveLength(3);
    await expect(fetchTranscript('https://example.org/v', fake({}))).rejects.toThrow(/Not a YouTube video/);
  });
});

describe('segment times are verified, never trusted', () => {
  const cache: TranscriptCache = { videoId: ID, url: '', title: '', duration: 600, chapters: [{ start: 0, title: 'a' }, { start: 425, title: 'b' }, { start: 500, title: 'c' }], transcript: [{ start: 90, dur: 5.5, text: 'x' }, { start: 420.2, dur: 3, text: 'y' }], language: 'en', fetchedAt: '' };
  it('accepts times on a cue or chapter (±2 s), refuses invented ones', () => {
    const u = `https://youtu.be/${ID}`;
    expect(verifySegment({ url: u }, null)).toEqual({ verified: null, reason: 'whole video' });
    expect(verifySegment({ url: u, start: 91, end: 424 }, cache).verified).toBe(true); // cue start, cue end 423.2
    expect(verifySegment({ url: u, start: 425, end: 600 }, cache).verified).toBe(true); // chapter, video end
    expect(verifySegment({ url: u, start: 200, end: 424 }, cache)).toMatchObject({ verified: false, reason: expect.stringContaining('start 200s') });
    expect(verifySegment({ url: u, start: 90, end: 333 }, cache)).toMatchObject({ verified: false, reason: expect.stringContaining('end 333s') });
    expect(verifySegment({ url: u, start: 90, end: 424 }, null).verified).toBe(false);
    expect(verifySegment({ url: u, start: 90, end: 424, timestampVerified: false }, cache).verified).toBe(false);
  });

  it('marks the vault paths from the cache, plays unverified segments whole, and fetches with study transcript', async () => {
    const v = sampleVault('eos-v22a-');
    dirs.push(v.dir);
    claudeWrites(v.root);
    const p = join(v.root, 'semesters', 's1', 'subjects', 'demo', 'paths', 'demo-dot-product.yaml');
    writeFileSync(p, readFileSync(p, 'utf8').replace('end: "4:30"', 'end: "4:47"')); // a time Claude made up
    const svc = new StudyService({ vault: v.root });
    const segs = svc.conceptView({ id: 'demo-dot-product' }).path!.segments;
    expect(segs[0]).toMatchObject({ timestampVerified: false, verifyNote: expect.stringContaining('end 287s') });
    expect(segs[1]).toMatchObject({ timestampVerified: false, verifyNote: expect.stringContaining('only be checked for YouTube') });
    const vec = svc.conceptView({ id: 'demo-vectors-and-linear-combinations' }).path!.segments[0];
    expect(vec.timestampVerified).toBe(true);
    expect(svc.next().items[0]).toMatchObject({ concept: 'demo-vectors-and-linear-combinations', minutes: 10 });
    // fetching writes the cache and re-checks
    const r = await svc.transcript({ url: `https://www.youtube.com/watch?v=${ID}`, text: true, fetcher: fake({ '/watch?v=': WATCH, 'lang=de': XML }) });
    expect(r).toMatchObject({ videoId: ID, cues: 3, chapters: 3, file: `cache/transcripts/${ID}.json` });
    expect(r.text).toContain('[1:30] An eigenvector keeps');
    expect(existsSync(join(v.root, 'cache', 'transcripts', `${ID}.json`))).toBe(true);
    svc.close();
  });
});

describe('engine-owned vault files follow app updates', () => {
  it('refreshes marked job files and keeps files whose marker you removed', () => {
    const v = sampleVault('eos-v22b-');
    dirs.push(v.dir);
    const cur = join(v.root, '.claude', 'commands', 'curate.md');
    const lab = join(v.root, '.claude', 'commands', 'labs.md');
    writeFileSync(cur, readFileSync(cur, 'utf8').replace('never estimate or invent a time', 'OLD RULES'));
    writeFileSync(lab, readFileSync(lab, 'utf8').replace(MANAGED, 'my own version'));
    const r = initVault(v.root, { git: false });
    expect(r.updated).toContain(join('.claude', 'commands', 'curate.md'));
    expect(readFileSync(cur, 'utf8')).toContain('never estimate or invent a time');
    expect(readFileSync(lab, 'utf8')).toContain('my own version');
    writeFileSync(cur, readFileSync(cur, 'utf8').replace('never estimate or invent a time', 'OLD AGAIN'));
    new StudyService({ vault: v.root }).close(); // opening the vault refreshes too
    expect(readFileSync(cur, 'utf8')).toContain('never estimate or invent a time');
  });
});
