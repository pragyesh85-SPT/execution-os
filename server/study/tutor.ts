import { createHash, randomBytes } from 'node:crypto';
import { aiComplete, type AiConfig } from '../../src/lib/ai';
import { answerPrompt, explainPrompt, gradeExact, keywordAnswer, keywordExplain, readAnswerVerdict, readExplainVerdict, wrongFeedback } from '../../src/core/study/tutor';
import type { AnswerVerdict, ExplainVerdict, MistakeClass } from '../../src/core/study/types';
import { NO_TUTOR, type TutorConfig } from './config';
import { StudyError } from './errors';
import type { StudyService } from './service';

// The Quick Tutor on the hub. Pluggable provider (Execution OS AI layer: Claude API, OpenAI, Gemini,
// any OpenAI-compatible endpoint, or Ollama on this PC); none is configured by default. Every verdict
// is logged with the raw answer; each night Claude re-grades the low-confidence ones and a sample of the
// rest (`study tutor audit` / `study tutor regrade`). The tutor never grades 3-day tests.

export interface TutorProvider {
  name: string; // "anthropic:claude-haiku-4-5", "ollama:llama3.2", "mock"
  complete(system: string, user: string): Promise<string>;
}

export interface TutorSetup {
  provider: TutorProvider | null;
  cfg: TutorConfig;
}

/** A provider from the PC-only config (study.json). Null when none is set. */
export function providerFrom(cfg: TutorConfig): TutorProvider | null {
  if (!cfg || cfg.provider === 'none') return null;
  const ai: AiConfig =
    cfg.provider === 'ollama'
      ? { provider: 'compatible', apiKey: '', model: cfg.model || 'llama3.2', baseUrl: cfg.baseUrl || 'http://localhost:11434/v1' }
      : { provider: cfg.provider, apiKey: cfg.apiKey ?? '', model: cfg.model, baseUrl: cfg.baseUrl ?? '' };
  if (ai.provider !== 'compatible' && !ai.apiKey) return null;
  return { name: `${cfg.provider}:${ai.model}`, complete: (system, user) => aiComplete(ai, system, user, { json: true, maxTokens: 1200 }) };
}

const month = (t: number) => new Date(t).toISOString().slice(0, 7);

export class Tutor {
  constructor(
    private readonly svc: StudyService,
    private readonly setup: () => TutorSetup,
  ) {}

  spend(now = this.svc.clock()) {
    const r = this.svc.db.sql.prepare('SELECT usd, calls FROM spend WHERE month = ?').get(month(now)) as { usd: number; calls: number } | undefined;
    return { month: month(now), usd: r?.usd ?? 0, calls: r?.calls ?? 0 };
  }

  status() {
    const { provider, cfg } = this.setup();
    const s = this.spend();
    return { provider: provider?.name ?? null, configured: !!provider, monthlyCapUsd: cfg.monthlyCapUsd, spentUsd: Math.round(s.usd * 10000) / 10000, calls: s.calls, capReached: !!provider && s.usd >= cfg.monthlyCapUsd };
  }

  /** Ask the provider when one is set and under the cap; null means "use the built-in matcher". */
  private async ask(system: string, user: string): Promise<{ reply: string; provider: string } | null> {
    const { provider, cfg } = this.setup();
    if (!provider) return null;
    const s = this.spend();
    if (s.usd >= cfg.monthlyCapUsd) return null;
    let reply: string;
    try {
      reply = await provider.complete(system, user);
    } catch (e) {
      this.svc.say(`Quick Tutor provider failed: ${(e as Error).message}`);
      return null;
    }
    const usd = ((system.length + user.length) / 4 / 1e6) * cfg.usdPerMTokIn + (reply.length / 4 / 1e6) * cfg.usdPerMTokOut;
    this.svc.db.sql.prepare('INSERT INTO spend (month, usd, calls) VALUES (?, ?, 1) ON CONFLICT(month) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1').run(s.month, usd);
    return { reply, provider: provider.name };
  }

  private saveVerdict(concept: string, kind: 'explain' | 'quick', question: string | null, answer: string, verdict: unknown, provider: string, confidence: string): string {
    const id = `v-${this.svc.clock().toString(36)}${randomBytes(3).toString('hex')}`;
    this.svc.db.sql.prepare('INSERT INTO verdicts (id, at, concept, kind, question, answer, verdict, provider, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, this.svc.clock(), concept, kind, question, answer.slice(0, 8000), JSON.stringify(verdict), provider, confidence);
    return id;
  }

  private logMistakes(concept: string, mistakes: { cls: MistakeClass; detail?: string }[], verdict: string, source: 'tutor' | 'claude' = 'tutor') {
    for (const m of mistakes) this.svc.log({ kind: 'mistake', concept, data: { cls: m.cls, ...(m.detail ? { detail: m.detail } : {}), verdict }, source });
  }

  /** Check an explanation (typed or spoken) against the key points of the pack. */
  async explain(p: { concept: string; text: string }) {
    const { concept, pack, hintsOnly, title } = this.svc.packFor(p.concept);
    const text = p.text.trim();
    if (text.length < 20) throw new StudyError('Explain it in a few sentences first (at least 20 characters).');
    const { system, user } = explainPrompt(pack, title, text, hintsOnly);
    const r = await this.ask(system, user);
    let v: ExplainVerdict | null = r ? readExplainVerdict(pack, r.reply) : null;
    const provider = v && r ? r.provider : 'keywords';
    if (!v) v = keywordExplain(pack, text);
    const id = this.saveVerdict(concept, 'explain', null, text, v, provider, v.confidence);
    this.svc.log({ kind: 'explain', concept, data: { coverage: v.coverage, pass: v.pass, verdict: id, covered: v.covered, missed: v.missed }, source: 'tutor' });
    this.logMistakes(concept, v.mistakes, id);
    const kp = new Map(pack.keyPoints.map((k) => [k.id, k.text]));
    const alt = v.pass ? null : this.svc.conceptView({ id: concept }).path?.alternates[0] ?? null;
    return {
      verdict: id,
      pass: v.pass,
      coverage: v.coverage,
      covered: v.covered.map((x) => ({ id: x, text: kp.get(x)! })),
      missed: v.missed.map((x) => ({ id: x, text: hintsOnly ? 'one more idea is missing' : kp.get(x)! })),
      wrong: v.wrong.map((w) => ({ ...w, text: kp.get(w.id)! })),
      feedback: v.feedback,
      mistakes: v.mistakes,
      confidence: v.confidence,
      provider,
      next: v.pass ? 'quick' : 'watch',
      ...(v.pass ? {} : { hint: pack.hints[0] ?? null, alternate: alt }),
    };
  }

  /** Check one quick question. Numbers and choices are exact; short answers go to the provider. */
  async answer(p: { concept: string; question: string; answer: string; repair?: string }) {
    const { concept, pack, hintsOnly, title } = this.svc.packFor(p.concept);
    const q = pack.questions.find((x) => x.id === p.question);
    if (!q) throw new StudyError(`Question "${p.question}" is not in the pack for ${concept}.`, 404);
    const answer = p.answer.trim().slice(0, 2000);
    if (!answer) throw new StudyError('Type an answer first.');
    const exact = gradeExact(q, answer);
    let v: AnswerVerdict;
    let provider = 'exact';
    if (exact !== null) v = { questionId: q.id, correct: exact, feedback: '', ...(exact ? {} : { mistake: { cls: q.kind === 'numeric' ? 'calculation' : 'concept_gap' } }), confidence: 'high' };
    else {
      const { system, user } = answerPrompt(q, title, answer, hintsOnly);
      const r = await this.ask(system, user);
      const read = r ? readAnswerVerdict(q, r.reply) : null;
      if (read && r) {
        v = read;
        provider = r.provider;
      } else {
        const ok = keywordAnswer(q, answer);
        v = { questionId: q.id, correct: ok, feedback: '', ...(ok ? {} : { mistake: { cls: 'incomplete' } }), confidence: 'low' };
        provider = 'keywords';
      }
    }
    const wrongCount = this.svc.events().filter((e) => e.concept === concept && e.kind === 'quick' && e.data.question === q.id && e.data.correct === false).length;
    const feedback = v.correct ? v.feedback || 'Correct.' : wrongFeedback(q, pack.hints[Math.min(wrongCount, pack.hints.length - 1)], hintsOnly, hintsOnly ? '' : v.feedback);
    const id = this.saveVerdict(concept, 'quick', q.id, answer, v, provider, v.confidence);
    this.svc.log({ kind: 'quick', concept, data: { question: q.id, correct: v.correct, verdict: id, ...(p.repair ? { repair: p.repair } : {}) }, source: 'tutor' });
    if (v.mistake) this.logMistakes(concept, [v.mistake], id);
    if (p.repair && v.correct && this.svc.repairs().some((r) => r.key === p.repair)) this.svc.log({ kind: 'repair_done', concept, data: { key: p.repair }, source: 'tutor' });
    return { verdict: id, correct: v.correct, feedback, mistake: v.mistake ?? null, confidence: v.confidence, provider, rung: this.svc.states().get(concept)?.rung };
  }

  /** Verdicts Claude re-grades tonight: every low-confidence one and about one in five of the rest. */
  audit(p: { limit?: number } = {}) {
    const rows = this.svc.db.sql.prepare('SELECT * FROM verdicts WHERE audited_at IS NULL ORDER BY at').all() as { id: string; at: number; concept: string; kind: string; question: string | null; answer: string; verdict: string; provider: string; confidence: string }[];
    const sampled = (id: string) => createHash('sha1').update(id).digest()[0] % 5 === 0;
    const picked = rows.filter((r) => r.confidence === 'low' || sampled(r.id)).slice(0, p.limit ?? 200);
    const m = this.svc.model();
    return {
      total: rows.length,
      verdicts: picked.map((r) => {
        const pack = m.packs.get(r.concept);
        const q = r.question ? pack?.questions.find((x) => x.id === r.question) : undefined;
        return { id: r.id, at: r.at, concept: r.concept, kind: r.kind, provider: r.provider, confidence: r.confidence, answer: r.answer, verdict: JSON.parse(r.verdict) as unknown, ...(q ? { question: q.q, expected: q.answer, rubric: q.rubric ?? null } : {}), ...(r.kind === 'explain' && pack ? { keyPoints: pack.keyPoints.map((k) => ({ id: k.id, text: k.text })) } : {}) };
      }),
    };
  }

  /**
   * Claude's verdict replaces the tutor's. {agree: true} only marks it audited. For explanations pass
   * {coverage, pass}; for quick questions {correct}. Mastery follows at once (evidence overlay).
   */
  regrade(p: { id: string; agree?: boolean; coverage?: number; pass?: boolean; correct?: boolean; note?: string; mistakes?: { cls: MistakeClass; detail?: string }[] }) {
    const row = this.svc.db.sql.prepare('SELECT * FROM verdicts WHERE id = ?').get(p.id) as { id: string; concept: string; kind: string } | undefined;
    if (!row) throw new StudyError(`Unknown verdict "${p.id}"`, 404);
    const now = this.svc.clock();
    if (p.agree) {
      this.svc.db.sql.prepare('UPDATE verdicts SET audited_at = ? WHERE id = ?').run(now, p.id);
      return { ok: true, changed: false };
    }
    let final: Record<string, unknown>;
    if (row.kind === 'explain') {
      if (typeof p.coverage !== 'number' || p.coverage < 0 || p.coverage > 1 || typeof p.pass !== 'boolean') throw new StudyError('An explanation re-grade needs coverage (0–1) and pass (true/false).');
      final = { coverage: p.coverage, pass: p.pass };
    } else {
      if (typeof p.correct !== 'boolean') throw new StudyError('A quick-question re-grade needs correct (true/false).');
      final = { correct: p.correct };
    }
    if (p.note) final.note = p.note.slice(0, 500);
    this.svc.db.sql.prepare('UPDATE verdicts SET final = ?, audited_at = ? WHERE id = ?').run(JSON.stringify(final), now, p.id);
    this.svc.invalidateEvents();
    if (p.mistakes?.length) this.logMistakes(row.concept, p.mistakes, p.id, 'claude');
    return { ok: true, changed: true, rung: this.svc.states().get(row.concept)?.rung };
  }
}

export const noTutor = (): TutorSetup => ({ provider: null, cfg: NO_TUTOR });
