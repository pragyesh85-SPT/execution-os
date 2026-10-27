import { MISTAKE_CLASSES, type AnswerVerdict, type CheckPack, type ExplainVerdict, type MistakeClass, type PackQuestion } from './types';

// The Quick Tutor's rules. A small fast model may only COMPARE an answer with the check pack Claude
// wrote in advance: it marks key points covered / missed / wrong, labels mistakes and writes 2–3 lines
// of feedback. Everything it returns is validated here — an id that is not in the pack is dropped,
// the pass decision is made by this code, and mastery is moved by the hub, never by the model.

export const PASS_COVERAGE = 0.8;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.+\-/ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const has = (text: string, kw: string) => {
  const t = ` ${norm(text)} `;
  const k = norm(kw);
  if (!k) return false;
  return k.includes(' ') ? t.includes(` ${k} `) || t.includes(k) : new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t);
};

const words = (s: string) => norm(s).split(' ').filter((w) => w.length > 3);

// ---------- explanations ----------

export function explainPrompt(pack: CheckPack, conceptTitle: string, explanation: string, hintsOnly: boolean) {
  const system = [
    'You are the Quick Tutor of Study OS. You grade ONE explanation strictly against a check pack written in advance by a senior tutor.',
    'Rules: use only the key points, misconceptions and formulas in the pack. Never add new requirements, never teach beyond the pack.',
    'A key point is "covered" only if the explanation states it (in any words). It is "wrong" if the explanation states the opposite or a listed misconception.',
    `Mistake classes: ${MISTAKE_CLASSES.join(', ')}. Give a short detail (e.g. the formula or the confused idea).`,
    hintsOnly ? 'This concept is part of a live graded assignment: give hints only, never a full solution.' : '',
    'Feedback: 2–3 short lines, encouraging and specific. Reply with JSON only:',
    '{"covered":["k1"],"missed":["k2"],"wrong":[{"id":"k3","why":"..."}],"mistakes":[{"cls":"concept_gap","detail":"..."}],"feedback":"...","confidence":"high"|"low"}',
    'Use confidence "low" when the explanation is ambiguous or you are unsure.',
  ]
    .filter(Boolean)
    .join('\n');
  const user = JSON.stringify({
    concept: conceptTitle,
    keyPoints: pack.keyPoints.map((k) => ({ id: k.id, text: k.text })),
    misconceptions: pack.misconceptions.map((m) => m.text),
    formulas: pack.formulas,
    explanation: explanation.slice(0, 6000),
  });
  return { system, user };
}

const asMistakes = (v: unknown): { cls: MistakeClass; detail?: string }[] =>
  (Array.isArray(v) ? v : [])
    .map((m) => m as { cls?: unknown; detail?: unknown })
    .filter((m) => (MISTAKE_CLASSES as string[]).includes(String(m?.cls)))
    .slice(0, 5)
    .map((m) => ({ cls: m.cls as MistakeClass, ...(typeof m.detail === 'string' && m.detail.trim() ? { detail: m.detail.trim().slice(0, 80) } : {}) }));

/** Pull the first JSON object out of a reply (models sometimes wrap it in prose or fences). */
export function parseJson(reply: string): Record<string, unknown> | null {
  const s = reply.indexOf('{');
  const e = reply.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    const v = JSON.parse(reply.slice(s, e + 1));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Validate a model reply against the pack. Returns null when it is unusable. */
export function readExplainVerdict(pack: CheckPack, reply: string): ExplainVerdict | null {
  const j = parseJson(reply);
  if (!j) return null;
  const ids = new Set(pack.keyPoints.map((k) => k.id));
  const pick = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => ids.has(x)))];
  const wrong = (Array.isArray(j.wrong) ? j.wrong : [])
    .map((w) => (typeof w === 'string' ? { id: w, why: '' } : (w as { id?: unknown; why?: unknown })))
    .filter((w) => ids.has(String(w?.id)))
    .map((w) => ({ id: String(w.id), why: typeof w.why === 'string' ? w.why.slice(0, 200) : '' }));
  const wrongIds = new Set(wrong.map((w) => w.id));
  const covered = pick(j.covered).filter((x) => !wrongIds.has(x));
  const missed = [...ids].filter((x) => !covered.includes(x) && !wrongIds.has(x));
  if (!Array.isArray(j.covered) && !Array.isArray(j.missed)) return null;
  const coverage = covered.length / Math.max(1, ids.size);
  return {
    covered,
    missed,
    wrong,
    feedback: typeof j.feedback === 'string' ? j.feedback.trim().slice(0, 500) : '',
    mistakes: asMistakes(j.mistakes),
    coverage,
    pass: coverage >= PASS_COVERAGE && wrong.length === 0,
    confidence: j.confidence === 'high' ? 'high' : 'low',
  };
}

/** No provider (or it failed): keywords of each key point, always low confidence. */
export function keywordExplain(pack: CheckPack, explanation: string): ExplainVerdict {
  const covered: string[] = [];
  for (const k of pack.keyPoints) {
    const kws = k.keywords?.length ? k.keywords : words(k.text);
    const hits = kws.filter((w) => has(explanation, w)).length;
    if (k.keywords?.length ? hits >= 1 : hits >= Math.max(1, Math.ceil(kws.length / 2))) covered.push(k.id);
  }
  const missed = pack.keyPoints.map((k) => k.id).filter((x) => !covered.includes(x));
  const coverage = covered.length / Math.max(1, pack.keyPoints.length);
  const missedText = pack.keyPoints.filter((k) => missed.includes(k.id)).map((k) => k.text);
  return {
    covered,
    missed,
    wrong: [],
    feedback: missed.length ? `You covered ${covered.length} of ${pack.keyPoints.length} key points. Not yet clear: ${missedText.slice(0, 2).join('; ')}.` : 'All key points are there.',
    mistakes: missed.length ? [{ cls: 'incomplete' }] : [],
    coverage,
    pass: coverage >= PASS_COVERAGE,
    confidence: 'low',
  };
}

// ---------- quick questions ----------

/** "1/3", "0.333", "3", "-2.5e-3", "x = 4" → number. */
export function readNumber(s: string): number | null {
  const t = s.replace(/,/g, '').trim();
  const frac = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(t);
  if (frac && Number(frac[2]) !== 0) return Number(frac[1]) / Number(frac[2]);
  const m = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/i.exec(t);
  return m ? Number(m[0]) : null;
}

/** Numeric and multiple-choice answers never need a model. Null = needs judgement (short answers). */
export function gradeExact(q: PackQuestion, answer: string): boolean | null {
  if (q.kind === 'numeric') {
    const want = Number(q.answer);
    const got = readNumber(answer);
    if (got === null) return false;
    const tol = q.tolerance ?? Math.max(1e-9, Math.abs(want) * 1e-9);
    return Math.abs(got - want) <= tol;
  }
  if (q.kind === 'mcq') {
    const a = norm(answer);
    const opts = q.options ?? [];
    const idx = /^[a-z]$/.test(a) ? a.charCodeAt(0) - 97 : /^\d+$/.test(a) ? Number(a) - 1 : -1;
    const chosen = idx >= 0 && idx < opts.length ? opts[idx] : (opts.find((o) => norm(o) === a) ?? answer);
    return norm(chosen) === norm(q.answer);
  }
  return null;
}

export function keywordAnswer(q: PackQuestion, answer: string): boolean {
  if (q.keywords?.length) return q.keywords.filter((k) => has(answer, k)).length >= Math.max(1, Math.ceil(q.keywords.length / 2));
  const want = new Set(words(q.answer));
  if (!want.size) return norm(answer) === norm(q.answer);
  const got = words(answer).filter((w) => want.has(w)).length;
  return got / want.size >= 0.6;
}

export function answerPrompt(q: PackQuestion, conceptTitle: string, answer: string, hintsOnly: boolean) {
  const system = [
    'You are the Quick Tutor of Study OS. Decide whether ONE short answer matches the expected answer and rubric written in advance.',
    'Judge meaning, not wording. Do not add requirements beyond the rubric.',
    `If it is wrong, label the mistake with one class: ${MISTAKE_CLASSES.join(', ')}.`,
    hintsOnly ? 'This concept is part of a live graded assignment: never reveal the expected answer; give a hint.' : '',
    'Reply with JSON only: {"correct":true|false,"feedback":"one line","mistake":{"cls":"...","detail":"..."}|null,"confidence":"high"|"low"}',
  ]
    .filter(Boolean)
    .join('\n');
  const user = JSON.stringify({ concept: conceptTitle, question: q.q, expected: q.answer, rubric: q.rubric ?? '', answer: answer.slice(0, 2000) });
  return { system, user };
}

export function readAnswerVerdict(q: PackQuestion, reply: string): AnswerVerdict | null {
  const j = parseJson(reply);
  if (!j || typeof j.correct !== 'boolean') return null;
  const m = asMistakes(j.mistake ? [j.mistake] : [])[0];
  return { questionId: q.id, correct: j.correct, feedback: typeof j.feedback === 'string' ? j.feedback.trim().slice(0, 300) : '', ...(m && !j.correct ? { mistake: m } : {}), confidence: j.confidence === 'high' ? 'high' : 'low' };
}

/** Feedback for a wrong answer: the expected answer, unless the concept is in a live graded assignment. */
export function wrongFeedback(q: PackQuestion, hint: string | undefined, hintsOnly: boolean, extra = ''): string {
  if (hintsOnly) return `Not yet. Hint: ${hint ?? 'look at the definition again.'}`;
  return [extra, `Expected: ${q.answer}.`, hint ? `Hint: ${hint}` : ''].filter(Boolean).join(' ');
}
