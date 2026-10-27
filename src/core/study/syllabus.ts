import { slug } from './ids';
import type { AssetType, Subject, SyllabusTopic } from './types';

// The syllabus skeleton and the first, cheap classification of incoming assets. Claude refines both;
// the engine only needs enough to create every concept stub on day 1 and to file assets correctly.

export interface ParsedTopic extends SyllabusTopic {
  examWeight?: number;
  group?: string; // the parent bullet, when topics are nested
}

const HEADING = /^#{1,6}\s+(?:(?:week|module|unit|lecture|lec|chapter|wk)\s*[-#]?\s*(\d{1,3}))?\s*[:.\-—–]*\s*(.*)$/i;
const ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(.+?)\s*$/;

/** Every leaf bullet of syllabus.md becomes a topic. "{#id}" fixes the id, "(weight 2)" the exam weight. */
export function parseSyllabus(text: string, subject: string): ParsedTopic[] {
  const lines = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').split('\n');
  const topics: ParsedTopic[] = [];
  const used = new Set<string>();
  let week: number | undefined;
  const stack: { indent: number; text: string }[] = [];
  const items: { indent: number; text: string; week?: number }[] = [];
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h && line.trimStart().startsWith('#')) {
      if (h[1]) week = Number(h[1]);
      continue;
    }
    const m = ITEM.exec(line);
    if (m) items.push({ indent: m[1].replace(/\t/g, '  ').length, text: m[2], week });
  }
  items.forEach((it, i) => {
    while (stack.length && stack[stack.length - 1].indent >= it.indent) stack.pop();
    const next = items[i + 1];
    const isParent = !!next && next.indent > it.indent;
    if (isParent) {
      stack.push({ indent: it.indent, text: clean(it.text).title });
      return;
    }
    const c = clean(it.text);
    if (!c.title) return;
    let id = c.id ?? `${subject}-${slug(c.title)}`;
    if (!c.id) for (let n = 2; used.has(id); n++) id = `${subject}-${slug(c.title)}-${n}`;
    if (used.has(id)) return; // a repeated fixed id: keep the first
    used.add(id);
    topics.push({ id, subject, title: c.title, week: it.week, order: topics.length + 1, ...(c.weight ? { examWeight: c.weight } : {}), ...(stack.length ? { group: stack.map((s) => s.text).join(' › ') } : {}) });
  });
  return topics;
}

function clean(raw: string): { title: string; id?: string; weight?: number } {
  let t = raw;
  let id: string | undefined;
  let weight: number | undefined;
  t = t.replace(/\{#([a-z0-9][a-z0-9-]{0,79})\}/i, (_, x: string) => ((id = x.toLowerCase()), ''));
  t = t.replace(/\((?:weight|w)\s*[:=]?\s*(\d+(?:\.\d+)?)\)/i, (_, x: string) => ((weight = Number(x)), ''));
  t = t.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim().replace(/[.;:,]+$/, '');
  return { title: t.slice(0, 160), id, weight };
}

// ---------- assets ----------

export interface Classified {
  type: AssetType;
  week?: number;
  lecture?: number;
}

const RULES: [RegExp, AssetType][] = [
  [/syllabus|course[\s_-]*(outline|plan|structure)|curriculum/i, 'syllabus'],
  [/\bpyq|previous[\s_-]*year|past[\s_-]*paper|end[\s_-]*(sem|term)|mid[\s_-]*(sem|term)|question[\s_-]*paper/i, 'pyq'],
  [/quiz/i, 'quiz'],
  [/assign|assgn|homework|\bhw[\s_-]*\d|problem[\s_-]*set|\bpset/i, 'assignment'],
  [/transcript|caption|subtitle/i, 'transcript'],
  [/\blab\b|lab[\s_-]*\d|practical|notebook/i, 'practical'],
  [/slide|lecture|\blec[\s_-]*\d|\bppt|deck|presentation/i, 'slides'],
  [/notes?\b|handout|reading|summary/i, 'notes'],
  [/screen[\s_-]*shot|screen[\s_-]*cap|\bimg[\s_-]*\d/i, 'screenshot'],
];

/** Formats that say what they are whatever the name: subtitles are transcripts, notebooks are practicals. */
const STRONG_EXT: Record<string, AssetType> = { '.vtt': 'transcript', '.srt': 'transcript', '.ipynb': 'practical' };

const EXT_TYPE: Record<string, AssetType> = {
  '.vtt': 'transcript',
  '.srt': 'transcript',
  '.ipynb': 'practical',
  '.pptx': 'slides',
  '.ppt': 'slides',
  '.key': 'slides',
  '.png': 'screenshot',
  '.jpg': 'screenshot',
  '.jpeg': 'screenshot',
  '.webp': 'screenshot',
  '.heic': 'screenshot',
};

/** Type, week and lecture from the file path (folders count too: "Week 3/Lecture 2/slides.pdf"). */
export function classifyAsset(path: string): Classified {
  const p = path.replace(/\\/g, '/');
  const name = p.split('/').pop() ?? p;
  const ext = (/\.[a-z0-9]+$/i.exec(name)?.[0] ?? '').toLowerCase();
  let type: AssetType | undefined = STRONG_EXT[ext];
  if (!type) for (const [re, t] of RULES) if (re.test(name)) {
    type = t;
    break;
  }
  if (!type && EXT_TYPE[ext]) type = EXT_TYPE[ext];
  if (!type) for (const [re, t] of RULES) if (re.test(p)) {
    type = t;
    break;
  }
  const wk = /(?:week|wk)[\s_-]*0*(\d{1,2})|(?:^|[^a-z])w0*(\d{1,2})(?:[^0-9]|$)/i.exec(p);
  const lec = /(?:lecture|lec)[\s_-]*0*(\d{1,3})(?:[^0-9]|$)/i.exec(name) ?? /(?:lecture|lec)[\s_-]*0*(\d{1,3})(?:[^0-9]|$)/i.exec(p);
  return { type: type ?? 'other', ...(wk ? { week: Number(wk[1] ?? wk[2]) } : {}), ...(lec ? { lecture: Number(lec[1]) } : {}) };
}

/** Which subject a path belongs to: its id or most of its title words appear in the path. */
export function detectSubject(path: string, subjects: Subject[]): string | undefined {
  const p = path.toLowerCase().replace(/\\/g, '/');
  const parts = p.split(/[^a-z0-9]+/).filter(Boolean);
  let best: { id: string; score: number } | undefined;
  for (const s of subjects) {
    let score = 0;
    if (parts.includes(s.id.toLowerCase())) score += 6;
    if (s.code && p.includes(s.code.toLowerCase())) score += 10;
    const words = s.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !['and', 'its', 'with', 'basics', 'foundations', 'introduction'].includes(w));
    const hits = words.filter((w) => p.includes(w)).length;
    if (words.length) score += (hits / words.length) * 10; // all title words beat a bare id match
    if (score >= 4 && (!best || score > best.score)) best = { id: s.id, score };
  }
  return best?.id;
}
