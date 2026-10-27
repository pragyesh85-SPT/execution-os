import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTime } from '../../src/core/study/ids';
import type { Segment } from '../../src/core/study/types';
import { StudyError } from './errors';

// Claude cannot watch a video. Segment start/end times may therefore only come from text that YouTube
// itself publishes: the transcript (captions with timestamps) and the chapters (timestamps in the
// description). `study transcript <url>` fetches both into <vault>/cache/transcripts/<id>.json, and the
// indexer marks a segment's times verified only when they line up with a cue or a chapter there.
// Nothing here guesses a time.

export interface Cue {
  start: number; // seconds
  dur: number;
  text: string;
}

export interface Chapter {
  start: number;
  title: string;
}

export interface TranscriptCache {
  videoId: string;
  url: string;
  title: string;
  duration: number | null; // seconds
  chapters: Chapter[];
  transcript: Cue[] | null; // null = YouTube publishes no captions for this video
  language: string | null;
  fetchedAt: string;
  error?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The 11-character id of a YouTube URL (watch, youtu.be, embed, shorts, live), or null. */
export function videoIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return /^[\w-]{11}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    if (!/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) return null;
    const v = u.searchParams.get('v') ?? /^\/(embed|shorts|live)\/([\w-]{11})/.exec(u.pathname)?.[2] ?? null;
    return v && /^[\w-]{11}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The JSON object assigned to `name` in a page (`var ytInitialPlayerResponse = {...};`). */
export function extractJson(html: string, name: string): Record<string, unknown> | null {
  const i = html.indexOf(name);
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  if (s < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (inStr) {
      if (c === '\\') k++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(s, k + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** YouTube chapters are the timestamp lines of the description ("0:00 Intro"), first one at 0:00. */
export function chaptersFromDescription(desc: string): Chapter[] {
  const out: Chapter[] = [];
  for (const line of desc.split(/\r?\n/)) {
    const m = /^\s*(?:[-•*▶►]\s*)?\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:|]?\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const t = parseTime(m[1]);
    if (t !== undefined && m[2]) out.push({ start: t, title: m[2].slice(0, 120) });
  }
  out.sort((a, b) => a.start - b.start);
  // YouTube only treats it as chapters when the list starts at 0:00 and has at least 3 entries
  return out.length >= 3 && out[0].start === 0 ? out.filter((c, i) => i === 0 || c.start > out[i - 1].start) : [];
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Captions in YouTube's XML (<text start dur>), srv3 (<p t d> in ms) or json3 format. */
export function parseCaptions(body: string): Cue[] {
  const t = body.trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[] };
    return (j.events ?? [])
      .filter((e) => e.segs?.length)
      .map((e) => ({ start: (e.tStartMs ?? 0) / 1000, dur: (e.dDurationMs ?? 0) / 1000, text: decode((e.segs ?? []).map((s) => s.utf8 ?? '').join('')) }))
      .filter((c) => c.text);
  }
  const cues: Cue[] = [];
  for (const m of t.matchAll(/<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g)) cues.push({ start: Number(m[1]), dur: Number(m[2] ?? 0), text: decode(m[3]) });
  if (cues.length) return cues.filter((c) => c.text);
  for (const m of t.matchAll(/<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g)) cues.push({ start: Number(m[1]) / 1000, dur: Number(m[2] ?? 0) / 1000, text: decode(m[3]) });
  return cues.filter((c) => c.text);
}

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

/** English first (human captions before automatic ones), then any human track, then anything. */
export function pickTrack(tracks: Track[]): Track | null {
  const en = (t: Track) => t.languageCode.toLowerCase().startsWith('en');
  return tracks.find((t) => en(t) && t.kind !== 'asr') ?? tracks.find((t) => en(t)) ?? tracks.find((t) => t.kind !== 'asr') ?? tracks[0] ?? null;
}

const tracksOf = (pr: Record<string, unknown> | null): Track[] =>
  ((pr?.captions as { playerCaptionsTracklistRenderer?: { captionTracks?: Track[] } } | undefined)?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter((t) => t?.baseUrl);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36';

export async function fetchTranscript(url: string, fetcher: Fetcher = fetch as unknown as Fetcher): Promise<TranscriptCache> {
  const id = videoIdOf(url);
  if (!id) throw new StudyError(`Not a YouTube video link: ${url}`);
  const base = 'https://www.youtube.com';
  const page = await fetcher(`${base}/watch?v=${id}&hl=en`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!page.ok) throw new StudyError(`YouTube answered ${page.status} for ${id}`, 502);
  const html = await page.text();
  const pr = extractJson(html, 'ytInitialPlayerResponse');
  const vd = (pr?.videoDetails ?? {}) as { title?: string; lengthSeconds?: string; shortDescription?: string };
  const out: TranscriptCache = {
    videoId: id,
    url: `${base}/watch?v=${id}`,
    title: vd.title ?? '',
    duration: vd.lengthSeconds ? Number(vd.lengthSeconds) : null,
    chapters: chaptersFromDescription(vd.shortDescription ?? ''),
    transcript: null,
    language: null,
    fetchedAt: new Date().toISOString(),
  };
  // The watch page's caption links often need a browser token; the Android player API's links do not.
  let tracks: Track[] = [];
  const key = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
  if (key) {
    try {
      const r = await fetcher(`${base}/youtubei/v1/player?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId: id }),
      });
      if (r.ok) tracks = tracksOf(JSON.parse(await r.text()) as Record<string, unknown>);
    } catch {
      /* fall back to the watch page's tracks */
    }
  }
  if (!tracks.length) tracks = tracksOf(pr);
  const track = pickTrack(tracks);
  if (track) {
    try {
      const r = await fetcher(track.baseUrl.replace(/&fmt=[^&]*/, ''), { headers: { 'User-Agent': UA } });
      const cues = r.ok ? parseCaptions(await r.text()) : [];
      if (cues.length) {
        out.transcript = cues;
        out.language = `${track.languageCode}${track.kind === 'asr' ? ' (auto)' : ''}`;
      } else out.error = `captions listed but empty (HTTP ${r.status})`;
    } catch (e) {
      out.error = `captions could not be fetched: ${(e as Error).message}`;
    }
  } else out.error = 'no captions published for this video';
  return out;
}

export const cachePath = (vault: string, videoId: string) => join(vault, 'cache', 'transcripts', `${videoId}.json`);

export function readCache(vault: string, videoId: string): TranscriptCache | null {
  const f = cachePath(vault, videoId);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as TranscriptCache;
  } catch {
    return null;
  }
}

export function writeCache(vault: string, c: TranscriptCache) {
  mkdirSync(join(vault, 'cache', 'transcripts'), { recursive: true });
  writeFileSync(cachePath(vault, c.videoId), JSON.stringify(c, null, 1));
}

/** "[mm:ss] text" lines (and the chapter list) — what Claude reads to place a segment. */
export function transcriptText(c: TranscriptCache): string {
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  return [
    `# ${c.title} (${c.videoId})${c.duration ? ` · ${mmss(c.duration)}` : ''}`,
    c.chapters.length ? `## Chapters\n${c.chapters.map((ch) => `[${mmss(ch.start)}] ${ch.title}`).join('\n')}` : '## Chapters\n(none published)',
    c.transcript ? `## Transcript (${c.language})\n${c.transcript.map((q) => `[${mmss(q.start)}] ${q.text}`).join('\n')}` : `## Transcript\n(not available: ${c.error ?? 'unknown'})`,
  ].join('\n\n');
}

export const TOLERANCE = 2; // seconds

/**
 * Are a segment's start/end backed by the cached transcript or chapters? Start must sit within 2 s of a
 * cue start or a chapter start; end within 2 s of a cue end, a chapter boundary or the video's end.
 * A segment without start/end is the whole video (nothing to verify); an explicit false stays false.
 */
export function verifySegment(seg: Pick<Segment, 'url' | 'start' | 'end'> & { timestampVerified?: boolean }, cache: TranscriptCache | null): { verified: boolean | null; reason: string } {
  if (seg.start === undefined && seg.end === undefined) return { verified: null, reason: 'whole video' };
  if (seg.timestampVerified === false) return { verified: false, reason: 'marked unverified' };
  if (!cache) return { verified: false, reason: 'no transcript or chapters cached — run study transcript <url>' };
  const starts = [...(cache.transcript ?? []).map((q) => q.start), ...cache.chapters.map((c) => c.start), 0];
  const ends = [...(cache.transcript ?? []).map((q) => q.start + q.dur), ...cache.chapters.map((c) => c.start), ...(cache.duration ? [cache.duration] : [])];
  if (!(cache.transcript?.length || cache.chapters.length)) return { verified: false, reason: 'the video has no transcript or chapters' };
  const near = (t: number | undefined, list: number[]) => t === undefined || list.some((x) => Math.abs(x - t) <= TOLERANCE);
  if (!near(seg.start, starts)) return { verified: false, reason: `start ${seg.start}s matches no transcript line or chapter` };
  if (!near(seg.end, ends)) return { verified: false, reason: `end ${seg.end}s matches no transcript line or chapter` };
  if (cache.duration && (seg.end ?? 0) > cache.duration + TOLERANCE) return { verified: false, reason: 'end is after the video ends' };
  return { verified: true, reason: 'matches the transcript / chapters' };
}
