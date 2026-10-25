// Shared domain model for Execution OS.
// Everything in src/core is pure TypeScript (no DOM, no Node) so the web app,
// the local hub server and the Electron shell all run the same rules.

import type { FeatureKey } from './features';

export type Category =
  | 'sleep'
  | 'devotion'
  | 'iit'
  | 'founder'
  | 'meal'
  | 'care'
  | 'rest'
  | 'buffer'
  | 'entertainment';

export type Area = 'iit' | 'founder' | 'personal';

/** Every synced record carries `u` (last-updated ms) so devices can merge last-write-wins per record. */
export interface Synced {
  id: string;
  u: number; // last edit time (ms) — informational; sync decisions use `r`
  del?: boolean;
  r?: number; // hub revision of this version (assigned only by the hub on the PC)
}

/** A block in the master clock template. Times are minutes from midnight. */
export interface BlockDef {
  id: string;
  title: string;
  category: Category;
  start: number; // 0..1439, clock minute the block starts
  dur: number; // minutes
  fixed: boolean; // time-anchored: Rescue Mode never moves it
  focus: boolean; // tracked work block, Focus Guard active
  minMinutes: number; // how far Rescue Mode may compress it
  priority: number; // 1 = protect first, 5 = drop first
}

export interface TemplateDoc extends Synced {
  blocks: BlockDef[];
}

/** A block inside one day's plan. s/e are minutes since the day's start (0..1440). */
export interface PlanBlock {
  id: string;
  origin?: string; // id of the template block / mission it came from
  title: string;
  category: Category;
  s: number;
  e: number;
  fixed: boolean;
  focus: boolean;
  minMinutes: number;
  priority: number;
  exception?: boolean; // planned exception (e.g. movie)
  rescued?: boolean; // placed by Rescue Mode
  missed?: boolean; // ghost of a block that was missed before a rescue
  pinned?: boolean; // v2: the user locked this block to its clock time for this day (implies fixed)
  source?: BlockSource; // v2: who created the block (undefined = the master clock)
  joinUrl?: string; // v2: class / meeting link (https only; Join shown only for allow-listed domains)
  location?: string; // v2
  externalId?: string; // v2: stable id from an import (e.g. email message id + date) — re-imports update, never duplicate
  reminderMin?: number; // v2: notify this many minutes before the block
  goalId?: string; // v2: the target this block counts toward
}

export type BlockSource = 'template' | 'user' | 'rescue' | 'ai' | 'import';

export interface Step {
  id: string;
  text: string;
  done: boolean;
}

export interface Mission {
  title: string; // the one clear outcome for the block
  steps: Step[];
  estimate?: number; // minutes
  taskIds?: string[];
  source?: 'manual' | 'ai' | 'import';
  goalId?: string; // v2: the target this mission counts toward
}

export interface Outcome {
  id: string;
  text: string;
  area: Area;
  done: boolean;
}

export type RescueStrategy = 'balanced' | 'protect_study' | 'ship' | 'light';
export type RescueReason = 'wake' | 'not_started' | 'missed_protected' | 'manual';

export interface RescueInfo {
  at: number; // ms
  summary: string[];
  strategy?: RescueStrategy; // v2
  scope?: 'today' | 'week'; // v2
  reason?: RescueReason; // v2: why the rescue was needed (analytics)
}

export interface DayPlan extends Synced {
  // id = logical date key YYYY-MM-DD
  blocks: PlanBlock[];
  missions: Record<string, Mission>;
  outcomes: Outcome[];
  rescue?: RescueInfo; // the latest applied rescue
  rescues?: RescueInfo[]; // v2: every rescue applied to this day, oldest first
  guardPausedUntil?: number; // ms
  plannedBy?: 'manual' | 'ai' | 'import';
  dismissedRescueAt?: number; // ms - user chose "not now" on a rescue suggestion
}

export interface Session extends Synced {
  date: string;
  blockId: string;
  category: Category;
  start: number; // ms
  end?: number; // ms, undefined while running
}

export type ProofStatus = 'done' | 'partial' | 'none';

export interface Proof extends Synced {
  // id = `${date}:${blockId}`
  date: string;
  blockId: string;
  category: Category;
  status: ProofStatus;
  note: string;
  links: string[];
  auto: string[]; // automatically detected proof, e.g. "3 commits"
  at: number;
  percent?: number; // v2: 0..100 for partial
  remaining?: string; // v2: what is left (becomes a task)
  blockers?: string; // v2
  loggedVia?: 'app' | 'mcp'; // v2
  confirmed?: boolean; // v2: the user explicitly confirmed this log (required for MCP)
  goalId?: string; // v2 (targets)
  countDelta?: number; // v2: units a session completed toward a count target
}

export interface WakeRecord extends Synced {
  // id = date key
  verifiedAt: number;
  method: 'qr' | 'code' | 'bypass';
  lateMin: number;
}

export interface Task extends Synced {
  title: string;
  area: Area;
  deadline?: string; // YYYY-MM-DD
  estimate?: number; // minutes
  priority: 1 | 2 | 3; // 1 = high
  done: boolean;
  doneAt?: number;
  notes?: string;
  carried?: boolean; // moved here by Rescue Mode
  createdAt: number;
  goalId?: string; // v2: the target this task counts toward
}

export type RuleTrigger =
  | { type: 'block_start'; category: Category }
  | { type: 'block_missed'; category: Category; minutes: number }
  | { type: 'outcomes_done' }
  | { type: 'urge' }
  | { type: 'time'; at: number };

export type RuleAction =
  | { type: 'focus' }
  | { type: 'rescue' }
  | { type: 'notify'; message: string }
  | { type: 'unlock_ent' }
  | { type: 'save_later' };

export interface Rule extends Synced {
  enabled: boolean;
  trigger: RuleTrigger;
  action: RuleAction;
  cue: string; // the human sentence "IF ... THEN ..."
  createdAt: number;
}

export interface Distraction extends Synced {
  date: string;
  at: number;
  minutes: number;
  source: string; // "Netflix", "YouTube", "manual"...
  note?: string;
  kind: 'unplanned' | 'urge_resisted';
}

export interface LaterItem extends Synced {
  text: string;
  url?: string;
  at: number;
  done: boolean;
}

export interface Review extends Synced {
  // id = week key (Monday date)
  summary: string[];
  change?: string; // the one modification chosen for next week
  aiText?: string;
  at: number;
}

// ---------- v2: proposals ----------

export type ProposalKind = 'rescue' | 'day_plan' | 'week_plan' | 'import' | 'override';
export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'expired' | 'superseded';

export interface ProposedLine {
  kind: 'kept' | 'moved' | 'shortened' | 'split' | 'dropped' | 'added';
  blockId: string;
  title: string;
  from?: [number, number];
  to?: [number, number];
  reason: string;
}

export interface ProposedDay {
  date: string;
  blocks: PlanBlock[]; // complete, validated block list for the day
  missions?: Record<string, Mission>; // keyed by block id in `blocks`
  outcomes?: Outcome[]; // max 3
  lines: ProposedLine[]; // human-readable diff vs the base
}

export interface ProposalTask {
  title: string;
  area: Area;
  priority?: 1 | 2 | 3;
  deadline?: string;
  estimate?: number;
  notes?: string;
  carried?: boolean;
  goalId?: string;
}

export interface Proposal extends Synced {
  kind: ProposalKind;
  source: 'engine' | 'mcp' | 'automation';
  client?: string; // 'claude', 'chatgpt', 'claude-code' …
  title: string;
  rationale?: string;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  scopeAllowed: ('today' | 'week')[];
  date: string; // the first day ("today" for scope purposes)
  days: ProposedDay[];
  baseRevs: Record<string, number>; // date -> day record r at creation (0 = not materialised)
  baseU?: Record<string, number>; // date -> day record u at creation (catches edits not yet synced)
  tasksToAdd?: ProposalTask[]; // added when applied for the week (or for any scope if tasksToAddToday is absent)
  tasksToAddToday?: ProposalTask[]; // added instead when applied for today only
  rescue?: { strategy?: RescueStrategy; reason?: RescueReason; summary: string[] };
  warnings?: string[];
  supersedes?: string;
  group?: string; // alternatives offered together (e.g. three rescue strategies); applying one supersedes the rest
  appliedAt?: number;
  appliedScope?: 'today' | 'week';
  decidedBy?: string;
  rejectReason?: string;
}

// ---------- v2: targets ----------

export type GoalLevel = 'year' | 'month' | 'week' | 'day';

export type GoalMetric =
  | { kind: 'hours'; categories?: Category[] } // auto: credited minutes of linked work
  | { kind: 'count'; unit: string } // e.g. "modules", "videos"
  | { kind: 'binary' } // done / not done
  | { kind: 'milestones'; items: { id: string; text: string; done: boolean }[] };

export interface Goal extends Synced {
  level: GoalLevel;
  period: string; // '2026' | '2026-10' | week key (Monday, '2026-10-19') | '2026-10-24'
  parentId?: string; // a month's parent is a year goal, etc.
  title: string;
  area: Area;
  why?: string; // shown by the coach
  metric: GoalMetric;
  target: number; // hours | count | 1 | items.length
  checkins?: { at: number; value: number; note?: string }[]; // manual progress for count/hours
  status: 'active' | 'done' | 'dropped';
  order: number;
  createdAt: number;
  source?: 'manual' | 'ai';
  curve?: 'linear' | 'workdays'; // expected progress: every day, or Monday–Saturday only
}

// ---------- v2: coaching ----------

export interface CoachingNote extends Synced {
  // id = `${weekKey}:${n}`
  period: string; // week key
  grade: string; // A..F or "Not enough data" — always from the engine
  score: number;
  profile: string;
  evidence: string[]; // exactly 3 numeric facts
  wentWell?: string;
  leak: string;
  change: { cue: string; trigger?: RuleTrigger; action?: RuleAction }; // one-tap "Add rule"
  text?: string; // AI narrative, ≤ 120 words
  source: 'engine' | 'mcp';
  client?: string;
  createdAt: number;
}

export interface Settings extends Synced {
  name: string;
  dayStart: number; // clock minute the logical day starts (default = sleep end)
  protect: Partial<Record<Category, number>>; // daily protected minimum minutes
  targets: Partial<Record<Category, number>>; // daily target minutes
  driftMin: number;
  rescueMin: number;
  autoRescue: boolean;
  wakeGate: boolean;
  wakeCode: string;
  wakeGraceMin: number;
  entBudgetMin: number; // weekly entertainment budget
  theme: 'auto' | 'light' | 'dark';
  focusBlock: string[]; // domains
  focusAllow: string[]; // domains always allowed
  focusKeywords: string[]; // window title keywords (Windows watcher)
  sound: boolean;
  notifyBlocks: boolean;
  githubUser?: string;
  onboarded: boolean;
  startedOn?: string; // first tracked day; stats ignore days before it
  features?: Partial<Record<FeatureKey, boolean>>; // v2 feature flags (Settings → Labs)
  coachStrictness?: 'gentle' | 'direct' | 'drill'; // v2: changes the coach's wording only
  joinDomains?: string[]; // v2: extra meeting domains allowed for one-tap Join (on top of the built-in list)
}

export interface Doc {
  settings: Settings;
  template: TemplateDoc;
  days: Record<string, DayPlan>;
  sessions: Record<string, Session>;
  proofs: Record<string, Proof>;
  wake: Record<string, WakeRecord>;
  tasks: Record<string, Task>;
  rules: Record<string, Rule>;
  distractions: Record<string, Distraction>;
  later: Record<string, LaterItem>;
  reviews: Record<string, Review>;
  proposals: Record<string, Proposal>; // v2
  goals: Record<string, Goal>; // v2
  coaching: Record<string, CoachingNote>; // v2
}

export type CollectionKey =
  | 'days'
  | 'sessions'
  | 'proofs'
  | 'wake'
  | 'tasks'
  | 'rules'
  | 'distractions'
  | 'later'
  | 'reviews'
  | 'proposals'
  | 'goals'
  | 'coaching';

export const COLLECTIONS: CollectionKey[] = [
  'days',
  'sessions',
  'proofs',
  'wake',
  'tasks',
  'rules',
  'distractions',
  'later',
  'reviews',
  'proposals',
  'goals',
  'coaching',
];

export type DayState = 'on_track' | 'drifting' | 'rescue';
