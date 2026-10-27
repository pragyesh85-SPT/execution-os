import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// The engine's share of extraction: plain text out of every format it can read without a model.
// Formulas as LaTeX, diagrams, handwriting and scanned PDFs are Claude's job in /ingest — those files
// come back with needsClaude: true. Nothing here ever changes the original file.

export interface Extracted {
  text: string;
  pages?: number; // slides or pages found
  needsClaude: boolean; // Claude must read the original (PDF without text, images, unknown formats)
  method: string;
}

const MAX_TEXT = 400_000;

// ---------- a minimal zip reader (pptx, docx and xlsx are zip files) ----------

export function readZip(buf: Buffer): Map<string, () => Buffer> {
  const out = new Map<string, () => Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip compression ${method}`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** Text runs of one OOXML part, one line per paragraph. */
function xmlText(xml: string, run: string, para: string): string {
  return xml
    .split(new RegExp(`</${para}>`))
    .map((p) => [...p.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([\\s\\S]*?)</${run}>`, 'g'))].map((m) => decodeXml(m[1])).join(''))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

const num = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

function pptx(buf: Buffer): Extracted {
  const z = readZip(buf);
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  const parts = slides.map((k) => {
    const body = xmlText(z.get(k)!().toString('utf8'), 'a:t', 'a:p');
    const notesKey = `ppt/notesSlides/notesSlide${num(k)}.xml`;
    const notes = z.has(notesKey) ? xmlText(z.get(notesKey)!().toString('utf8'), 'a:t', 'a:p') : '';
    return `## Slide ${num(k)}\n\n${body}${notes ? `\n\n> Notes: ${notes.replace(/\n/g, ' ')}` : ''}`;
  });
  const pictures = [...z.keys()].some((k) => k.startsWith('ppt/media/'));
  return { text: parts.join('\n\n'), pages: slides.length, needsClaude: pictures, method: 'pptx' };
}

function docx(buf: Buffer): Extracted {
  const z = readZip(buf);
  const doc = z.get('word/document.xml');
  if (!doc) throw new Error('no word/document.xml');
  const pictures = [...z.keys()].some((k) => k.startsWith('word/media/'));
  return { text: xmlText(doc().toString('utf8'), 'w:t', 'w:p'), needsClaude: pictures, method: 'docx' };
}

function ipynb(raw: string): Extracted {
  const nb = JSON.parse(raw) as { cells?: { cell_type?: string; source?: string | string[] }[] };
  const cells = (nb.cells ?? []).map((c) => {
    const src = Array.isArray(c.source) ? c.source.join('') : (c.source ?? '');
    return c.cell_type === 'code' ? '```python\n' + src.trim() + '\n```' : src.trim();
  });
  return { text: cells.filter(Boolean).join('\n\n'), pages: cells.length, needsClaude: false, method: 'ipynb' };
}

/** Subtitles → "[mm:ss] text" lines (one per cue), so Claude can cite timestamps. */
function subtitles(raw: string): Extracted {
  const cues: string[] = [];
  const blocks = raw.replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n/, '').split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/^NOTE/.test(l));
    const t = lines.findIndex((l) => l.includes('-->'));
    if (t < 0) continue;
    const start = /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,]\d+/.exec(lines[t]);
    const words = lines
      .slice(t + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (!words) continue;
    const stamp = start ? `${start[1] ? start[1] : ''}${start[2].padStart(2, '0')}:${start[3]}` : '';
    cues.push(stamp ? `[${stamp}] ${words}` : words);
  }
  return { text: cues.join('\n'), pages: cues.length, needsClaude: false, method: 'subtitles' };
}

function html(raw: string): Extracted {
  const text = decodeXml(
    raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { text, needsClaude: false, method: 'html' };
}

let pdftotext: boolean | null = null;
function pdf(file: string): Extracted {
  if (pdftotext === null) pdftotext = spawnSync('pdftotext', ['-v'], { windowsHide: true }).status === 0;
  if (pdftotext) {
    const r = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && r.stdout.trim().length > 40) {
      const pages = r.stdout.split('\f');
      return { text: pages.map((p, i) => `## Page ${i + 1}\n\n${p.trim()}`).filter((p) => !/^## Page \d+\n\n$/.test(p)).join('\n\n'), pages: pages.length, needsClaude: true, method: 'pdftotext' };
    }
  }
  // Claude Code reads PDFs directly (text, formulas and figures) — that is better than a guess here.
  return { text: '', needsClaude: true, method: 'claude' };
}

const PLAIN = new Set(['.md', '.markdown', '.txt', '.tex', '.py', '.r', '.sql', '.csv', '.tsv', '.json', '.yaml', '.yml', '.m', '.java', '.c', '.cpp', '.js', '.ts']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.bmp']);

export function extractFile(file: string): Extracted {
  const ext = extname(file).toLowerCase();
  try {
    let r: Extracted;
    if (PLAIN.has(ext)) {
      let t = readFileSync(file, 'utf8').replace(/^﻿/, '');
      if (ext === '.csv' || ext === '.tsv') t = t.split('\n').slice(0, 200).join('\n');
      r = { text: ['.md', '.markdown', '.txt', '.tex'].includes(ext) ? t : '```\n' + t + '\n```', needsClaude: false, method: 'text' };
    } else if (ext === '.vtt' || ext === '.srt') r = subtitles(readFileSync(file, 'utf8'));
    else if (ext === '.html' || ext === '.htm') r = html(readFileSync(file, 'utf8'));
    else if (ext === '.ipynb') r = ipynb(readFileSync(file, 'utf8'));
    else if (ext === '.pptx') r = pptx(readFileSync(file));
    else if (ext === '.docx') r = docx(readFileSync(file));
    else if (ext === '.pdf') r = pdf(file);
    else if (IMAGES.has(ext)) r = { text: '', needsClaude: true, method: 'image' };
    else r = { text: '', needsClaude: true, method: 'unknown' };
    return { ...r, text: r.text.slice(0, MAX_TEXT) };
  } catch (e) {
    return { text: '', needsClaude: true, method: `failed: ${(e as Error).message}` };
  }
}
