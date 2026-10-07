// Shared domain model for Execution OS.
// Everything in src/core is pure TypeScript (no DOM, no Node) so the web app,
// the local hub server and the Electron shell all run the same rules.

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
}

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
}

export interface Outcome {
  id: string;
  text: string;
  area: Area;
  done: boolean;
}

export interface RescueInfo {
  at: number; // ms
  summary: string[];
}

export interface DayPlan extends Synced {
  // id = logical date key YYYY-MM-DD
  blocks: PlanBlock[];
  missions: Record<string, Mission>;
  outcomes: Outcome[];
  rescue?: RescueInfo;
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
  | 'reviews';

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
];

export type DayState = 'on_track' | 'drifting' | 'rescue';
