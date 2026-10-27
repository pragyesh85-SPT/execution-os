import { DAY_MS } from './ids';
import type { FsrsCard } from './types';

// FSRS (Free Spaced Repetition Scheduler, v4.5 formulas with the published default weights).
// A card is created when a concept reaches Applied (first recall due about 3–4 days later) and is
// replayed from evidence every time — nothing here is stored, so a re-graded answer re-plans reviews.
// Grades: 1 again (wrong), 2 hard, 3 good, 4 easy.

export type Grade = 1 | 2 | 3 | 4;

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81; // R(S, S) = 0.9
export const TARGET_RETENTION = 0.9;

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const initD = (g: Grade) => clampD(W[4] - (g - 3) * W[5]);

/** Probability of recalling the concept `elapsedDays` after the last review. */
export const retrievability = (elapsedDays: number, stability: number) => Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / stability, DECAY);

/** Days until retrievability falls to the target (at least one day). */
export const intervalDays = (stability: number, r = TARGET_RETENTION) => Math.max(1, Math.round((stability / FACTOR) * (Math.pow(r, 1 / DECAY) - 1)));

export function newCard(at: number, g: Grade = 3): FsrsCard {
  const stability = W[g - 1];
  return { stability, difficulty: initD(g), last: at, due: at + intervalDays(stability) * DAY_MS, reps: 1, lapses: g === 1 ? 1 : 0 };
}

export function review(card: FsrsCard, at: number, g: Grade): FsrsCard {
  const elapsed = Math.max(0, (at - card.last) / DAY_MS);
  const R = retrievability(elapsed, card.stability);
  const D = card.difficulty;
  const d2 = clampD(W[7] * initD(3) + (1 - W[7]) * (D - W[6] * (g - 3)));
  let S: number;
  if (g === 1) {
    S = Math.min(card.stability, W[11] * Math.pow(D, -W[12]) * (Math.pow(card.stability + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R)));
  } else {
    const bonus = (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1);
    S = card.stability * (Math.exp(W[8]) * (11 - D) * Math.pow(card.stability, -W[9]) * (Math.exp(W[10] * (1 - R)) - 1) * bonus + 1);
  }
  S = Math.max(0.1, S);
  return { stability: S, difficulty: d2, last: at, due: at + intervalDays(S) * DAY_MS, reps: card.reps + 1, lapses: card.lapses + (g === 1 ? 1 : 0) };
}

export const recallNow = (card: FsrsCard, now: number) => retrievability((now - card.last) / DAY_MS, card.stability);
