import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Concept, Segment } from '../../src/core/study/types';
import { RUNG_LABEL } from '../../src/core/study/types';
import type { StudyService } from './service';

// The portfolio: everything learned from world universities and open courses, generated from evidence
// (weekly by /week-end, or `study portfolio`). Private: it stays in portfolio/ until you publish it.
// IITJ material never appears here — IITJ sources are filtered out and no asset is ever copied.

export interface PortfolioEntry {
  university: string;
  source: string;
  course: string | null;
  lecture: string | null;
  url: string;
  segment: string | null; // "4:30–12:10" or "pages 12–15"
  concept: string;
  conceptTitle: string;
  subject: string;
  date: string;
  minutes: number | null;
  rung: string;
  explanation: string | null; // your own words (the explanation that passed)
  quickCheck: number | null; // 0..1
  lab: string | null; // vault path of your lab code
}

const IITJ = /iit\s*-?\s*j|iitj|jodhpur/i;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function isIitj(s: Pick<Segment, 'source' | 'university' | 'url' | 'course'>): boolean {
  return IITJ.test(s.source) || IITJ.test(s.university ?? '') || IITJ.test(s.course ?? '') || /(^|\.)iitj\.ac\.in/i.test(new URL(s.url).hostname);
}

export function portfolioEntries(svc: StudyService): PortfolioEntry[] {
  const m = svc.model();
  const st = svc.states();
  const out: PortfolioEntry[] = [];
  const seen = new Set<string>();
  const explanations = new Map<string, string>();
  for (const r of svc.db.sql.prepare("SELECT concept, answer, verdict, final FROM verdicts WHERE kind = 'explain' ORDER BY at").all() as { concept: string; answer: string; verdict: string; final: string | null }[]) {
    const v = JSON.parse(r.final ?? r.verdict) as { pass?: boolean };
    if (v.pass) explanations.set(r.concept, r.answer);
  }
  for (const e of svc.events()) {
    if (e.kind !== 'segment_done' || !e.concept) continue;
    const c: Concept | undefined = m.concepts.get(e.concept);
    const path = c && m.paths.get(c.id);
    if (!c || !path) continue;
    const all = [...path.segments, ...path.alternates];
    const seg = typeof e.data.url === 'string' ? all.find((s) => s.url === e.data.url) : e.data.alternate ? path.alternates[Number(e.data.index ?? 0)] : path.segments[Number(e.data.index ?? 0)];
    if (!seg || isIitj(seg)) continue;
    const key = `${c.id}|${seg.url}|${seg.start ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lab = m.labs.get(c.id);
    const labFile = lab ? `${lab.hiddenTests.split('/').slice(0, -1).join('/')}/my_solution.py` : null;
    out.push({
      university: seg.university || seg.source,
      source: seg.source,
      course: seg.course ?? null,
      lecture: seg.lecture ?? null,
      url: seg.url,
      segment: seg.start !== undefined && seg.end !== undefined ? `${fmt(seg.start)}–${fmt(seg.end)}` : seg.pages ? `pages ${seg.pages}` : null,
      concept: c.id,
      conceptTitle: c.title,
      subject: c.subject,
      date: day(e.at),
      minutes: seg.start !== undefined && seg.end !== undefined ? Math.round((seg.end - seg.start) / 60) : null,
      rung: RUNG_LABEL[st.get(c.id)?.rung ?? 'none'],
      explanation: explanations.get(c.id) ?? null,
      quickCheck: st.get(c.id)?.mastery.recall ?? null,
      lab: labFile && existsSync(join(svc.root, labFile)) && st.get(c.id)?.mastery.implementation === 1 ? labFile : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.university.localeCompare(b.university));
}

export function writePortfolio(svc: StudyService) {
  const entries = portfolioEntries(svc);
  const dir = svc.L.portfolio;
  mkdirSync(dir, { recursive: true });
  const subjects = new Map(svc.model().subjects.map((s) => [s.id, s.title]));
  const group = <K extends keyof PortfolioEntry>(k: K) => {
    const g = new Map<string, PortfolioEntry[]>();
    for (const e of entries) (g.get(String(e[k])) ?? g.set(String(e[k]), []).get(String(e[k]))!).push(e);
    return [...g].sort((a, b) => b[1].length - a[1].length);
  };
  const minutes = entries.reduce((a, e) => a + (e.minutes ?? 0), 0);
  const totals = { entries: entries.length, concepts: new Set(entries.map((e) => e.concept)).size, hours: Math.round(minutes / 6) / 10, labs: entries.filter((e) => e.lab).length, universities: group('university').length };
  const json = { generatedAt: new Date(svc.clock()).toISOString(), totals, entries };
  writeFileSync(join(dir, 'portfolio.json'), JSON.stringify(json, null, 2));

  const line = (e: PortfolioEntry) => `- ${e.date} · **${e.conceptTitle}** — [${e.source}${e.course ? ` · ${e.course}` : ''}${e.lecture ? ` · ${e.lecture}` : ''}](${e.url})${e.segment ? ` (${e.segment})` : ''} · ${e.rung}${e.quickCheck !== null ? ` · quick check ${Math.round(e.quickCheck * 100)}%` : ''}${e.lab ? ` · [lab](../${e.lab})` : ''}`;
  const md = [
    '# Learning portfolio',
    '',
    `_Private — generated ${json.generatedAt.slice(0, 10)} from Study OS evidence. Publish only what you choose._`,
    '',
    `**${totals.concepts} concepts · ${totals.hours} h of lectures · ${totals.labs} labs · ${totals.universities} universities and open courses**`,
    '',
    '## By university',
    '',
    ...group('university').flatMap(([u, es]) => [`### ${u} (${es.length})`, '', ...es.map(line), '']),
    '## By subject',
    '',
    ...group('subject').flatMap(([s, es]) => [`### ${subjects.get(s) ?? s} (${es.length})`, '', ...es.map(line), '']),
    '## In my own words',
    '',
    ...entries.filter((e) => e.explanation).map((e) => `**${e.conceptTitle}** — ${e.explanation!.replace(/\s+/g, ' ').slice(0, 600)}\n`),
  ].join('\n');
  writeFileSync(join(dir, 'index.md'), md);

  const rows = entries.map((e) => `<tr><td>${esc(e.date)}</td><td>${esc(e.university)}</td><td><a href="${esc(e.url)}">${esc([e.course, e.lecture].filter(Boolean).join(' · ') || e.source)}</a>${e.segment ? ` <small>${esc(e.segment)}</small>` : ''}</td><td>${esc(e.conceptTitle)}</td><td>${esc(subjects.get(e.subject) ?? e.subject)}</td><td>${esc(e.rung)}</td></tr>`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Learning portfolio</title><style>
:root{--bg:#f6f4ef;--ink:#1c1b19;--ink2:#57534b;--line:#e2ded4;--accent:#d9480f}@media (prefers-color-scheme:dark){:root{--bg:#121110;--ink:#edeae3;--ink2:#a8a397;--line:#2c2a27;--accent:#f26b3a}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:980px;margin:auto}h1{margin:0 0 4px}p{color:var(--ink2)}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}a{color:var(--accent)}small{color:var(--ink2)}.wrap{overflow-x:auto}
</style></head><body><main><h1>Learning portfolio</h1><p>${totals.concepts} concepts · ${totals.hours} h · ${totals.labs} labs · ${totals.universities} universities and open courses</p><div class="wrap"><table><thead><tr><th>Date</th><th>University</th><th>Course · lecture</th><th>Concept</th><th>Subject</th><th>Level</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></main></body></html>`;
  writeFileSync(join(dir, 'index.html'), html);
  return { totals, files: ['portfolio/index.md', 'portfolio/index.html', 'portfolio/portfolio.json'] };
}
