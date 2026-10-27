import '../quiet';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { METHODS } from './api';
import { StudyConfigFile } from './config';
import { StudyService } from './service';
import { providerFrom } from './tutor';
import { runJob } from './jobs';
import { commitVault, defaultVaultPath, initVault, isVault } from './vault';
import type { QueueItem } from '../../src/core/study/types';

// The `study` command line — for you and for Claude Code inside the vault.
//   study init <vault-path>     create the Study Vault (template, git, `study` shims)
//   study ingest <folder>       copy, classify and extract new assets, then index
//   study status                what the vault holds, parse errors, last jobs
//   study next                  the queue: repairs, reviews, tests, next concepts
//   … `study help` lists everything.
// When the hub (Execution OS) is running, every command goes through its Study API, so study.db keeps
// one writer. When it is not running, the CLI opens the vault directly (nothing else is writing then).

export interface CliEnv {
  out?: (s: string) => void;
  err?: (s: string) => void;
  eosDb?: string; // Execution OS database (decides where study.json lives)
  port?: number;
  engine?: string; // path of build/study.cjs for the vault shims
  clock?: () => number;
  hub?: boolean; // false: never try the hub (tests)
}

export interface Client {
  mode: 'hub' | 'local';
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export class CliError extends Error {}

const appData = () => process.env.APPDATA ?? join(homedir(), '.config');
export const eosDbPath = () => process.env.EOS_DB ?? join(appData(), 'execution-os', 'execution-os.db');

async function hubUp(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return ((await r.json()) as { app?: string }).app === 'execution-os';
  } catch {
    return false;
  }
}

/** The "study" flag as saved in the Execution OS database (used only when the hub is not running). */
export function flagInDb(dbFile: string): boolean | null {
  if (!existsSync(dbFile)) return null;
  try {
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const row = db.prepare("SELECT data FROM records WHERE col = 'settings' AND id = 'settings'").get() as { data: string } | undefined;
      const f = row ? (JSON.parse(row.data) as { features?: Record<string, boolean> }).features?.study : undefined;
      return f ?? false;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function connect(env: CliEnv, vault: string): Promise<Client> {
  const port = env.port ?? Number(process.env.EOS_PORT ?? 4747);
  if (env.hub !== false && (await hubUp(port))) {
    const base = `http://127.0.0.1:${port}/api/study`;
    return {
      mode: 'hub',
      async call<T>(method: string, params: Record<string, unknown> = {}) {
        const res = await fetch(`${base}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-EOS-DEVICE': 'study CLI' }, body: JSON.stringify(params), signal: AbortSignal.timeout(10 * 60_000) });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new CliError(body.error ?? `The hub answered ${res.status}`);
        return body as T;
      },
      close() {},
    };
  }
  const flag = flagInDb(env.eosDb ?? eosDbPath());
  if (flag === false) throw new CliError('Study OS is switched off. Turn it on in Execution OS → Settings → Labs → Study OS.');
  const tutorCfg = new StudyConfigFile(env.eosDb ?? eosDbPath());
  const svc = new StudyService({ vault, clock: env.clock, tutor: () => ({ provider: providerFrom(tutorCfg.tutor()), cfg: tutorCfg.tutor() }) });
  return {
    mode: 'local',
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      const m = METHODS[method];
      if (!m) throw new CliError(`Unknown Study OS method "${method}".`);
      return (await m.run(svc, params, { local: true, device: 'cli' })) as T;
    },
    close: () => svc.close(),
  };
}

type Out = (s: string) => void;
interface Cmd {
  usage: string;
  help: string;
  noVault?: boolean;
  run: (args: string[], ctx: { client: () => Promise<Client>; out: Out; json: boolean; env: CliEnv; config: StudyConfigFile; vault: string; setExit: (code: number) => void }) => Promise<void>;
}

const print = (out: Out, json: boolean, value: unknown, human: () => string) => out(json ? JSON.stringify(value, null, 2) : human());

export const COMMANDS: Record<string, Cmd> = {
  init: {
    usage: 'study init <vault-path>',
    help: 'Create the Study Vault (or complete an existing one). Never overwrites a file.',
    noVault: true,
    async run(args, { out, json, env, config }) {
      const target = resolve(args[0] ?? config.vault());
      const r = initVault(target, { engine: env.engine, node: process.execPath });
      config.write({ vault: target });
      print(out, json, r, () =>
        [
          `Study Vault ready at ${r.root}`,
          `  ${r.created.length} file(s) created, ${r.kept.length} kept as they were · git: ${r.git}`,
          `  Saved as the vault for this PC in ${config.file}`,
          '',
          'Next:',
          '  1. Execution OS → Settings → Labs → switch on "Study OS".',
          `  2. Put each subject's full outline in ${join(r.root, 'semesters', 's1', 'subjects', '<subject>', 'syllabus.md')}.`,
          '  3. study ingest <folder with the IITJ assets>',
        ].join('\n'),
      );
    },
  },
  status: {
    usage: 'study status',
    help: 'What the vault holds, files that did not parse, last jobs.',
    async run(_a, { client, out, json }) {
      const c = await client();
      const s = (await c.call('status')) as ReturnType<StudyService['status']>;
      print(out, json, { mode: c.mode, ...s }, () => {
        const lines = [
          `${s.name} · ${s.vault} · semester ${s.semester} · ${c.mode === 'hub' ? 'via the hub' : 'hub not running (direct)'}`,
          `  concepts ${s.counts.concepts} · paths ${s.counts.paths} · packs ${s.counts.packs} · labs ${s.counts.labs} · questions ${s.counts.questions} · assets ${s.counts.assets} · events ${s.counts.events}`,
        ];
        if (s.errors.length) lines.push(`  ${s.errors.length} file(s) did not parse:`, ...s.errors.slice(0, 20).map((e) => `    ${e.path}: ${e.error}`));
        return lines.join('\n');
      });
    },
  },
  next: {
    usage: 'study next',
    help: 'The queue: repairs first, then due reviews, the 3-day test, the next concepts.',
    async run(_a, { client, out, json }) {
      const c = await client();
      const r = (await c.call('next')) as { items: QueueItem[] };
      print(out, json, r, () => (r.items.length ? r.items.map((i, n) => `${String(n + 1).padStart(2)}. [${i.kind}${i.kind === 'learn' ? `: ${i.step}` : ''}] ${i.title} (${i.minutes} min) — ${i.why}${i.kind === 'learn' && i.segment ? `\n      ${i.segment.source}: ${i.segment.url}` : ''}`).join('\n') : 'Nothing queued yet. Add the syllabus and run: study ingest <folder>'));
    },
  },
  ingest: {
    usage: 'study ingest <folder|file> [--subject s] [--week n] [--type t] [--move]',
    help: 'Copy new IITJ assets into the vault, classify, extract text, create concept stubs.',
    async run(args, { client, out, json }) {
      const { pos, flags } = parseFlags(args);
      if (!pos[0]) throw new CliError('Usage: study ingest <folder> [--subject s] [--week n] [--type t] [--move]');
      const r = (await (await client()).call('ingest', { folder: resolve(pos[0]), subject: flags.subject, week: flags.week === undefined ? undefined : Number(flags.week), type: flags.type, move: flags.move === true })) as {
        added: { id: string; subject: string; type: string; week: number | null; needsClaude: boolean }[];
        duplicates: string[];
        unsorted: string[];
        skipped: { file: string; reason: string }[];
        syllabusWritten: string[];
        index: { stubs: number; errors: { path: string; error: string }[] };
      };
      print(out, json, r, () =>
        [
          `${r.added.length} asset(s) added, ${r.duplicates.length} already in the vault, ${r.unsorted.length} without a subject (inbox/unsorted), ${r.skipped.length} skipped.`,
          ...r.added.map((a) => `  + ${a.id}  [${a.subject} · ${a.type}${a.week !== null ? ` · week ${a.week}` : ''}]${a.needsClaude ? '  needs Claude (/ingest)' : ''}`),
          ...r.unsorted.map((u) => `  ? ${u}  subject unknown — re-run with --subject, or let /ingest file it`),
          ...r.skipped.map((s) => `  - ${s.file}: ${s.reason}`),
          ...(r.syllabusWritten.length ? [`  syllabus filled from: ${r.syllabusWritten.join(', ')}`] : []),
          `  ${r.index.stubs} concept stub(s) created from the syllabus${r.index.errors.length ? ` · ${r.index.errors.length} file(s) did not parse (study status)` : ''}`,
          'Next: run /ingest in Claude Code (or wait for the 2-hourly job) to decompose the assets into concepts.',
        ].join('\n'),
      );
    },
  },
  pending: {
    usage: 'study pending [--quiet]',
    help: 'New work for /ingest (inbox, unsorted, new assets). Exit code 10 when there is none.',
    async run(args, { client, out, json, setExit }) {
      const r = (await (await client()).call('pending')) as { inbox: string[]; unsorted: string[]; newAssets: string[]; total: number };
      if (!r.total) setExit(10);
      if (args.includes('--quiet')) return;
      print(out, json, r, () => (r.total ? [`${r.total} item(s) waiting:`, ...r.inbox.map((f) => `  inbox: ${f}`), ...r.unsorted.map((f) => `  unsorted: ${f}`), ...r.newAssets.map((a) => `  new asset: ${a}`)].join('\n') : 'Nothing new.'));
    },
  },
  concepts: {
    usage: 'study concepts [subject]',
    help: 'Every concept with its ladder status and what it still lacks (path, pack, lab).',
    async run(args, { client, out, json }) {
      const r = (await (await client()).call('concepts', { subject: args[0] })) as { concepts: { id: string; title: string; week: number | null; status: string; rung: string; nextStep: string; hasPath: boolean; hasPack: boolean; hasLab: boolean; released: boolean }[] };
      print(out, json, r, () =>
        r.concepts.length
          ? r.concepts.map((c) => `${c.id.padEnd(34)} ${(c.week === null ? '' : `w${c.week}`).padEnd(4)} ${c.rung.padEnd(10)} ${c.status === 'stub' ? 'stub ' : '     '}${c.hasPath ? 'path ' : '---- '}${c.hasPack ? 'pack ' : '---- '}${c.hasLab ? 'lab ' : '--- '}${c.released ? '' : '(unreleased) '}${c.title}`).join('\n')
          : 'No concepts yet. Fill syllabus.md and run: study reindex',
      );
    },
  },
  concept: {
    usage: 'study concept <id>',
    help: 'One concept: card, ladder, mastery, resource path, pack (without answers), recent evidence.',
    async run(args, { client, out }) {
      if (!args[0]) throw new CliError('Usage: study concept <id>');
      out(JSON.stringify(await (await client()).call('concept', { id: args[0] }), null, 2));
    },
  },
  log: {
    usage: "study log <kind> <concept|-> ['<json>'] [--source claude]",
    help: 'Record evidence: explain, quick, lab, review, test_item, mistake, repair_done, segment_done …',
    async run(args, { client, out, json }) {
      const { pos, flags } = parseFlags(args);
      const [kind, concept, raw] = pos;
      if (!kind) throw new CliError("Usage: study log <kind> <concept|-> '<json>'");
      let data: unknown = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new CliError('The data must be JSON, e.g. \'{"coverage":0.85,"pass":true}\'');
      }
      const r = await (await client()).call('log', { kind, concept: concept && concept !== '-' ? concept : undefined, data, source: typeof flags.source === 'string' ? flags.source : 'cli' });
      print(out, json, r, () => `Recorded ${kind}${concept && concept !== '-' ? ` for ${concept}` : ''}${(r as { rung?: string }).rung ? ` · now ${(r as { rung?: string }).rung}` : ''}.`);
    },
  },
  start: {
    usage: 'study start [concept]',
    help: 'Start studying: Execution OS shows "Studying now", runs the timer and turns Focus Guard on.',
    async run(args, { client, out, json }) {
      const r = (await (await client()).call('start', { concept: args[0] })) as { id: string; label: string; eos: { how: string } | null };
      print(out, json, r, () => `${r.label} — session ${r.id}${r.eos ? ` (${r.eos.how === 'swap' ? 'swapped the current block to study' : r.eos.how === 'live' ? 'live block added from now' : r.eos.how === 'none' ? 'no block — logged as a free session' : 'inside the current block'})` : ' (Execution OS is not running: not recorded there)'}`);
    },
  },
  stop: {
    usage: 'study stop [note]',
    help: 'Stop the session; the Execution OS proof fills itself (concepts, questions, lab).',
    async run(args, { client, out, json }) {
      const r = (await (await client()).call('stop', { note: args.join(' ') || undefined })) as { line: string; minutes: number };
      print(out, json, r, () => `Stopped after ${r.minutes} min: ${r.line}`);
    },
  },
  progress: {
    usage: 'study progress',
    help: 'Coverage, readiness, pace, projected ready date, per subject.',
    async run(_a, { client, out, json }) {
      const p = (await (await client()).call('progress')) as import('../../src/core/study/types').Progress;
      const pc = (n: number) => `${Math.round(n * 100)}%`;
      print(out, json, p, () =>
        [
          `Exam in ${p.daysToExam} days (${p.examStart}) · ready by ${p.readyBy} (${p.daysToReady} days) · projected ${p.projectedReady ?? 'unknown'}`,
          `Coverage ${pc(p.coverage)} (released ${pc(p.releasedCoverage)}) · readiness ${pc(p.readiness)} · IITJ track ${pc(p.iitjTrack)} · pace ${p.pace.status}${p.pace.behindBy ? ` (behind by ${p.pace.behindBy})` : ''}: need ${p.pace.neededPerDay.toFixed(1)}/day, doing ${p.pace.averagePerDay.toFixed(1)}/day`,
          ...p.subjects.map((s) => `  ${s.title.padEnd(44)} ${String(s.applied).padStart(3)}/${String(s.concepts).padEnd(4)} coverage ${pc(s.coverage).padStart(4)} · readiness ${pc(s.readiness)}`),
        ].join('\n'),
      );
    },
  },
  deadline: {
    usage: 'study deadline submit <id>',
    help: 'Mark an IITJ assignment / quiz submitted (its task is done; hints-only ends).',
    async run(args, { client, out }) {
      if (args[0] !== 'submit' || !args[1]) throw new CliError('Usage: study deadline submit <id>');
      await (await client()).call('deadlineSubmit', { id: args[1] });
      out(`Marked ${args[1]} submitted.`);
    },
  },
  iitj: {
    usage: 'study iitj lecture <asset-id> [concept]',
    help: 'Record an IITJ lecture as watched (IITJ track %).',
    async run(args, { client, out }) {
      if (args[0] !== 'lecture' || !args[1]) throw new CliError('Usage: study iitj lecture <asset-id> [concept]');
      await (await client()).call('iitjLecture', { asset: args[1], concept: args[2] });
      out(`Recorded lecture ${args[1]}.`);
    },
  },
  assets: {
    usage: 'study assets [--status new|processed|unsorted] [--subject s]',
    help: 'Ingested assets and where their extracted text is.',
    async run(args, { client, out, json }) {
      const { flags } = parseFlags(args);
      const r = (await (await client()).call('assets', { status: flags.status, subject: flags.subject })) as { assets: { id: string; type: string; status: string; path: string; extracted: string | null; needsClaude: boolean }[] };
      print(out, json, r, () => r.assets.map((a) => `${a.id.padEnd(40)} ${a.type.padEnd(11)} ${a.status.padEnd(9)} ${a.needsClaude ? 'needs Claude  ' : '              '}${a.extracted ?? a.path}`).join('\n') || 'No assets.');
    },
  },
  'asset-done': {
    usage: 'study asset-done <id>',
    help: '/ingest: mark an asset decomposed into concepts.',
    async run(args, { client, out }) {
      if (!args[0]) throw new CliError('Usage: study asset-done <id>');
      await (await client()).call('assetDone', { id: args[0] });
      out(`${args[0]} processed.`);
    },
  },
  reindex: {
    usage: 'study reindex',
    help: 'Re-read changed vault files now (the hub also does this on every change).',
    async run(_a, { client, out, json }) {
      const r = (await (await client()).call('reindex')) as { scanned: number; changed: number; removed: number; stubs: string[]; errors: { path: string; error: string }[] };
      print(out, json, r, () => [`${r.scanned} file(s), ${r.changed} changed, ${r.removed} removed, ${r.stubs.length} stub(s) created.`, ...r.errors.map((e) => `  ! ${e.path}: ${e.error}`)].join('\n'));
    },
  },
  state: {
    usage: 'study state',
    help: 'Regenerate STATE.md (the brief every Claude session reads first).',
    async run(_a, { client, out, json }) {
      const r = (await (await client()).call('state')) as { file: string; text: string };
      print(out, json, r, () => r.text);
    },
  },
  session: {
    usage: 'study session <id>',
    help: 'The report of one study session.',
    async run(args, { client, out }) {
      if (!args[0]) throw new CliError('Usage: study session <id>');
      out(JSON.stringify(await (await client()).call('session', { id: args[0] }), null, 2));
    },
  },
  tutor: {
    usage: "study tutor status|audit|regrade <id> '<json>'|set <provider> <model> [--key k] [--url u] [--cap usd]",
    help: 'Quick Tutor: provider and spend, verdicts to re-grade tonight, your re-grade.',
    async run(args, { client, out, json, config }) {
      const { pos, flags } = parseFlags(args);
      const sub = pos[0] ?? 'status';
      if (sub === 'set') {
        const [, provider, model] = pos;
        const P = ['anthropic', 'openai', 'gemini', 'compatible', 'ollama', 'none'];
        if (!provider || !P.includes(provider)) throw new CliError(`Usage: study tutor set <${P.join('|')}> <model> [--key k] [--url u] [--cap usd]`);
        const cur = config.tutor();
        const next = {
          ...cur,
          provider: provider as typeof cur.provider,
          model: model ?? cur.model,
          ...(typeof flags.key === 'string' ? { apiKey: flags.key } : {}),
          ...(typeof flags.url === 'string' ? { baseUrl: flags.url } : {}),
          ...(typeof flags.cap === 'string' ? { monthlyCapUsd: Number(flags.cap) } : {}),
          ...(typeof flags['price-in'] === 'string' ? { usdPerMTokIn: Number(flags['price-in']) } : {}),
          ...(typeof flags['price-out'] === 'string' ? { usdPerMTokOut: Number(flags['price-out']) } : {}),
        };
        config.write({ tutor: next });
        out(`Quick Tutor: ${next.provider}${next.model ? ` · ${next.model}` : ''} · cap $${next.monthlyCapUsd}/month · key ${next.apiKey ? 'saved on this PC only' : 'none'}. Saved in ${config.file}.`);
        return;
      }
      const c = await client();
      if (sub === 'status') {
        const s = (await c.call('tutorStatus')) as { provider: string | null; monthlyCapUsd: number; spentUsd: number; calls: number; capReached: boolean };
        return print(out, json, s, () =>
          s.provider
            ? `Quick Tutor: ${s.provider} · this month ${s.calls} call(s), about $${s.spentUsd} of $${s.monthlyCapUsd}${s.capReached ? ' — CAP REACHED (built-in matcher until next month)' : ''}`
            : 'Quick Tutor: no provider set — the built-in keyword matcher answers (low confidence; Claude re-grades nightly). Set one: study tutor set ollama llama3.2',
        );
      }
      if (sub === 'audit') return out(JSON.stringify(await c.call('tutorAudit', { limit: flags.limit ? Number(flags.limit) : undefined }), null, 2));
      if (sub === 'regrade') {
        if (!pos[1] || !pos[2]) throw new CliError(`Usage: study tutor regrade <verdict-id> '{"agree":true}' | '{"coverage":0.6,"pass":false}' | '{"correct":true}'`);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(pos[2]) as Record<string, unknown>;
        } catch {
          throw new CliError('The re-grade must be JSON.');
        }
        return print(out, json, await c.call('tutorRegrade', { ...body, id: pos[1] }), () => `Re-graded ${pos[1]}.`);
      }
      throw new CliError('Usage: study tutor status|audit|regrade|set');
    },
  },
  lab: {
    usage: 'study lab run <lab-id|concept> <file.py>',
    help: 'Run your code against the hidden tests of a lab (on this PC).',
    async run(args, { client, out, json }) {
      if (args[0] !== 'run' || !args[1] || !args[2]) throw new CliError('Usage: study lab run <lab-id|concept> <file.py>');
      const code = readFileSync(resolve(args[2]), 'utf8');
      const c = await client();
      const list = (await c.call('concepts')) as { concepts: { id: string }[] };
      const isConcept = list.concepts.some((x) => x.id === args[1]);
      const r = (await c.call('labRun', { ...(isConcept ? { concept: args[1] } : { lab: args[1] }), code })) as { ok: boolean; passed: number; total: number; tests: { name: string; ok: boolean; error?: string }[]; error?: string };
      print(out, json, r, () => [`${r.ok ? 'PASSED' : 'NOT YET'} — ${r.passed}/${r.total} hidden tests`, ...r.tests.map((t) => `  ${t.ok ? '✓' : '✗'} ${t.name}${t.error ? `: ${t.error}` : ''}`), ...(r.error ? [`  ${r.error}`] : [])].join('\n'));
    },
  },
  test: {
    usage: 'study test plan|due|build --auto|check <id>|start <id> [--subject s]|submit <id> <answers.json>|finalize <id>|report <id>|list',
    help: 'The 3-day test: blueprint, paper, taking it, grading, report.',
    async run(args, { client, out, json }) {
      const { pos, flags } = parseFlags(args);
      const [sub = 'list', id] = pos;
      const c = await client();
      const need = () => {
        if (!id) throw new CliError(`Usage: study test ${sub} <YYYY-MM-DD>`);
        return id;
      };
      switch (sub) {
        case 'plan':
          return out(JSON.stringify(await c.call('testPlan', { written: flags.written ? Number(flags.written) : undefined }), null, 2));
        case 'due':
          return out(JSON.stringify(await c.call('testBuildDue'), null, 2));
        case 'build': {
          if (flags.auto !== true) throw new CliError('/build-test writes the paper; for the built-in fallback run: study test build --auto');
          const r = (await c.call('testBuild', { id })) as { id: string; items: number; file: string };
          return print(out, json, r, () => `Built ${r.file} with ${r.items} item(s). Check it: study test check ${r.id}`);
        }
        case 'check': {
          const r = (await c.call('testCheck', { id: need() })) as { ok: boolean; problems: string[]; items: number; marks: number };
          return print(out, json, r, () => (r.ok ? `OK — ${r.items} items, ${r.marks} marks.` : ['Problems:', ...r.problems.map((p) => `  - ${p}`)].join('\n')));
        }
        case 'start':
          return out(JSON.stringify(await c.call('testStart', { id: need(), subject: flags.subject }), null, 2));
        case 'submit': {
          const file = pos[2];
          if (!file) throw new CliError('Usage: study test submit <id> <answers.json>   ({"<item>": {"text": "…"} | {"code": "…"}})');
          const answers = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<string, unknown>;
          return out(JSON.stringify(await c.call('testSubmit', { id: need(), subject: flags.subject, answers }), null, 2));
        }
        case 'finalize': {
          const r = (await c.call('testFinalize', { id: need() })) as { total: { marks: number; max: number; pct: number } };
          return print(out, json, r, () => `Test ${id}: ${r.total.marks}/${r.total.max} (${Math.round(r.total.pct * 100)}%). Report: tests/${id}/report.md`);
        }
        case 'report': {
          const r = (await c.call('testReport', { id: need() })) as { markdown: string | null };
          return print(out, json, r, () => r.markdown ?? JSON.stringify(r, null, 2));
        }
        case 'list': {
          const r = (await c.call('tests')) as { tests: { id: string; status: string; items: number; pct: number | null }[]; nextDue: string | null };
          return print(out, json, r, () => [...r.tests.map((t) => `${t.id}  ${t.status.padEnd(9)} ${t.items} items${t.pct !== null ? ` · ${Math.round(t.pct * 100)}%` : ''}`), `Next test due: ${r.nextDue ?? 'unknown'}`].join('\n'));
        }
        default:
          throw new CliError(COMMANDS.test.usage);
      }
    },
  },
  'run-job': {
    usage: 'study run-job <ingest|curate|packs|labs|day-end|build-test|grade|week-end> [--force]',
    help: 'Run a headless Claude job now (what Task Scheduler runs). Skips when there is no work.',
    async run(args, { client, out, json, vault, setExit }) {
      const { pos, flags } = parseFlags(args);
      if (!pos[0]) throw new CliError(COMMANDS['run-job'].usage);
      const r = await runJob(pos[0], { vault, client: await client(), force: flags.force === true, log: json ? () => {} : out });
      if (r.ran && !r.ok) setExit(1);
      print(out, json, r, () => (r.ran ? `Job ${r.job} ${r.ok ? 'ok' : 'FAILED'} — ${r.steps.map((s) => `/${s.command} ${s.ok ? 'ok' : `exit ${s.code}`}`).join(', ')}. Log: ${r.log}` : `Job ${r.job} skipped: ${r.reason}.`));
    },
  },
  jobs: {
    usage: 'study jobs',
    help: 'The last run of every headless job.',
    async run(_a, { client, out, json }) {
      const r = (await (await client()).call('jobs')) as { jobs: { job: string; ok: boolean; ended: number; log: string | null }[] };
      print(out, json, r, () => r.jobs.map((j) => `${j.job.padEnd(11)} ${j.ok ? 'ok    ' : 'FAILED'} ${new Date(j.ended).toLocaleString()}  ${j.log ?? ''}`).join('\n') || 'No job has run yet.');
    },
  },
  proposals: {
    usage: 'study proposals [apply|reject <id>]',
    help: 'Graph / path changes proposed through MCP; apply (undoable) or reject them.',
    async run(args, { client, out, json }) {
      const c = await client();
      if ((args[0] === 'apply' || args[0] === 'reject') && args[1]) {
        const r = await c.call(args[0] === 'apply' ? 'proposalApply' : 'proposalReject', { id: args[1] });
        return print(out, json, r, () => `${args[0] === 'apply' ? 'Applied' : 'Rejected'} ${args[1]}.${(r as { audit?: number }).audit ? ` Undo: study undo ${(r as { audit: number }).audit}` : ''}`);
      }
      const r = (await c.call('proposals', { status: 'pending' })) as { proposals: { id: string; title: string; client: string | null; payload: { rationale?: string } }[] };
      print(out, json, r, () => r.proposals.map((p) => `${p.id}  ${p.title}${p.client ? ` (from ${p.client})` : ''}${p.payload.rationale ? ` — ${p.payload.rationale}` : ''}`).join('\n') || 'No pending proposals.');
    },
  },
  undo: {
    usage: 'study undo [<change-number>]',
    help: 'List recent AI changes to the vault, or put one back.',
    async run(args, { client, out, json }) {
      const c = await client();
      if (args[0]) return print(out, json, await c.call('undo', { seq: Number(args[0]) }), () => `Undone #${args[0]}.`);
      const r = (await c.call('changes')) as { changes: { seq: number; at: number; actor: string; action: string; undone: boolean }[] };
      print(out, json, r, () => r.changes.map((x) => `#${x.seq}  ${new Date(x.at).toLocaleString()}  ${x.actor}: ${x.action}${x.undone ? ' (undone)' : ''}`).join('\n') || 'No changes yet.');
    },
  },
  capture: {
    usage: 'study capture "<text>" [--url u] [--subject s]',
    help: 'Drop a note, question or link into inbox/ for the next ingest.',
    async run(args, { client, out }) {
      const { pos, flags } = parseFlags(args);
      const r = (await (await client()).call('capture', { text: pos.join(' '), url: flags.url, subject: flags.subject })) as { file: string };
      out(`Captured: ${r.file}`);
    },
  },
  portfolio: {
    usage: 'study portfolio',
    help: 'Regenerate portfolio/ (world-university sources only; private until you publish it).',
    async run(_a, { client, out, json }) {
      const r = (await (await client()).call('portfolio')) as { totals: { concepts: number; hours: number; labs: number; universities: number }; files: string[] };
      print(out, json, r, () => `Portfolio: ${r.totals.concepts} concepts, ${r.totals.hours} h, ${r.totals.labs} labs, ${r.totals.universities} sources → ${r.files.join(', ')}`);
    },
  },
  dedupe: {
    usage: 'study dedupe',
    help: 'Likely duplicate concepts, broken links and prerequisite cycles (for /week-end).',
    async run(_a, { client, out, json }) {
      const r = (await (await client()).call('dedupe')) as { duplicates: { a: string; b: string; similarity: number }[]; broken: { concept: string; field: string; target: string; problem: string }[]; cycles: string[][] };
      print(out, json, r, () =>
        [
          `${r.duplicates.length} likely duplicate(s), ${r.broken.length} broken link(s), ${r.cycles.length} cycle(s).`,
          ...r.duplicates.map((d) => `  dup   ${d.a} ~ ${d.b} (${d.similarity})`),
          ...r.broken.map((b) => `  link  ${b.concept}.${b.field} → ${b.target}: ${b.problem}`),
          ...r.cycles.map((c) => `  cycle ${c.join(' → ')}`),
        ].join('\n'),
      );
    },
  },
  commit: {
    usage: 'study commit "<message>"',
    help: 'Commit the vault (local git only). Every headless job ends with this.',
    async run(args, { out, vault }) {
      const r = commitVault(vault, args.join(' ').trim() || 'Study OS update');
      if (!r.ok) throw new CliError(`git commit failed: ${r.out}`);
      out(r.out || 'Committed.');
    },
  },
};

const BOOL_FLAGS = new Set(['move', 'quiet', 'dry-run', 'force', 'json']);

/** "--subject lana --week 3 --move" → flags; everything else stays positional. */
export function parseFlags(args: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (!BOOL_FLAGS.has(k) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[k] = args[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const HELP_ORDER = () => Object.keys(COMMANDS);

export function helpText(): string {
  return ['study — Study OS command line', '', ...HELP_ORDER().map((k) => `  ${COMMANDS[k].usage.padEnd(44)} ${COMMANDS[k].help}`), '', 'Add --json for machine-readable output.'].join('\n');
}

export async function runStudyCli(argv: string[], env: CliEnv = {}): Promise<number> {
  const out = env.out ?? ((s: string) => console.log(s));
  const err = env.err ?? ((s: string) => console.error(s));
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const [name = 'help', ...rest] = args;
  if (name === 'help' || name === '--help' || name === '-h') {
    out(helpText());
    return 0;
  }
  if (name === 'version' || name === '--version') {
    out(typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev');
    return 0;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    err(`Unknown command "${name}".\n\n${helpText()}`);
    return 2;
  }
  const config = new StudyConfigFile(env.eosDb ?? eosDbPath());
  const vault = config.vault();
  let client: Client | null = null;
  let code = 0;
  try {
    if (!cmd.noVault && !isVault(vault)) throw new CliError(`No Study Vault at ${vault}. Create it first: study init ${vault === defaultVaultPath() ? defaultVaultPath() : vault}`);
    await cmd.run(rest, {
      out,
      json,
      env,
      config,
      vault,
      setExit: (c) => (code = c),
      client: async () => (client ??= await connect(env, vault)),
    });
    return code;
  } catch (e) {
    err((e as Error).message);
    return 1;
  } finally {
    (client as Client | null)?.close();
  }
}
