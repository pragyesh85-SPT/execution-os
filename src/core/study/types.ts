// Study OS domain model. Pure TypeScript (no DOM, no Node), shared by the hub, the `study` CLI,
// the MCP tools and the Study tab. Vault files (written by Claude) are parsed into these shapes;
// evidence events are the only input that moves a concept up the ladder.

export type AssetType = 'slides' | 'transcript' | 'notes' | 'assignment' | 'quiz' | 'pyq' | 'practical' | 'screenshot' | 'syllabus' | 'other';
export const ASSET_TYPES: AssetType[] = ['slides', 'transcript', 'notes', 'assignment', 'quiz', 'pyq', 'practical', 'screenshot', 'syllabus', 'other'];

export interface Subject {
  id: string; // slug used in folder names, e.g. "lana"
  title: string;
  code?: string;
  examWeight: number; // relative weight of the subject in the end-term (any scale; normalised)
}

export interface Deadline {
  id: string;
  subject: string;
  title: string;
  kind: 'assignment' | 'quiz' | 'exam' | 'other';
  due: string; // YYYY-MM-DD
  graded: boolean; // a live graded item: Study OS gives hints only until it is submitted
  submitted?: boolean;
  url?: string;
}

export interface Assessment {
  semester: string; // "s1"
  studyStart: string; // YYYY-MM-DD, day 1 for pace
  examStart: string; // YYYY-MM-DD
  readyBy?: string; // default: examStart minus 15 days
  testEveryDays: number; // 3
  testMinutes: number; // default length of a 3-day test
  subjects: Subject[];
  components: { subject: string; name: string; weight: number; kind: string; date?: string }[];
  deadlines: Deadline[];
  endTerm?: { format: string[]; notes?: string };
}

export interface Formula {
  id: string;
  latex: string;
  name?: string;
}

export interface Concept {
  id: string;
  subject: string;
  title: string;
  week?: number;
  order: number; // position in the syllabus
  status: 'stub' | 'ready'; // stub = known from the syllabus, not decomposed from assets yet
  released: boolean; // covered by an IITJ asset released so far
  examWeight: number; // default 1
  minutes: number; // estimated learning time, 20–40
  prereqs: string[];
  confusedWith: string[];
  testedBy: string[];
  definition?: string;
  formulas: Formula[];
  sources: { asset: string; ref?: string }[]; // IITJ references (slide / page)
  notation: { iitj: string; resource: string; meaning?: string }[];
  graded?: string; // id of a live graded deadline this concept is part of (hints only)
  mergedInto?: string; // duplicate merged into another concept
  body?: string; // the Markdown body of the card
  file: string;
}

export type SegmentKind = 'intuition' | 'formal' | 'example';

export interface Segment {
  kind: SegmentKind;
  url: string;
  start?: number; // seconds
  end?: number; // seconds
  pages?: string; // "12-15" for a book or notes
  source: string; // "3Blue1Brown", "MIT OCW"
  university?: string; // "MIT", "Harvard", "Stanford", "Brown" … (portfolio)
  course?: string;
  lecture?: string;
  why: string; // one line: why this segment was chosen
  checkedAt?: string; // YYYY-MM-DD the link was last fetched and verified
  dead?: boolean;
  // start/end proven by the video's own transcript or chapters (study transcript <url>); false = play the
  // whole video and show "times not verified". Computed by the hub from the cache; never trusted from Claude.
  timestampVerified?: boolean;
  verifyNote?: string;
}

export interface ResourcePath {
  concept: string;
  segments: Segment[]; // 1–3: intuition → formal → example
  alternates: Segment[]; // used after a missed check
  file: string;
}

export interface PackQuestion {
  id: string;
  q: string;
  answer: string;
  kind: 'short' | 'numeric' | 'mcq';
  options?: string[];
  tolerance?: number; // numeric answers: absolute tolerance
  rubric?: string;
  keywords?: string[]; // what a correct short answer must mention (used without an AI provider)
}

export interface CheckPack {
  concept: string;
  keyPoints: { id: string; text: string; keywords?: string[] }[]; // 5–8
  misconceptions: { id: string; text: string }[];
  questions: PackQuestion[]; // 5–10
  formulas: string[];
  hints: string[]; // 2 retry hints
  file: string;
}

export interface Lab {
  concept: string;
  id: string;
  title: string;
  task: string; // what to implement (Markdown)
  entry: string; // function name the hidden tests call
  starter?: string; // starter code
  hiddenTests: string; // path of the hidden test file, relative to the vault
  timeoutSec: number;
  file: string;
}

export type QuestionKind = 'conceptual' | 'numerical' | 'derivation' | 'mcq' | 'programming';

export interface BankQuestion {
  id: string;
  subject: string;
  concepts: string[];
  source: 'pyq' | 'official' | 'external' | 'generated';
  style?: 'iitj';
  kind: QuestionKind;
  q: string;
  answer?: string;
  rubric?: { point: string; marks: number }[];
  marks: number;
  transfer?: boolean; // mixes concepts / applies one in a new setting
  entry?: string; // programming
  starter?: string;
  tests?: string; // programming: hidden test file, relative to the vault
  file: string;
}

export interface SyllabusTopic {
  id: string; // concept id it becomes
  subject: string;
  title: string;
  week?: number;
  order: number;
}

// ---------- evidence ----------

export type EventKind =
  | 'segment_done' // a resource segment was watched to the end
  | 'explain' // an explanation was checked against the pack
  | 'quick' // one quick question was answered
  | 'lab' // a lab was run against its hidden tests
  | 'review' // a spaced review
  | 'test_item' // one graded item of a 3-day test
  | 'mistake' // a classified mistake
  | 'repair_done' // a repair item's retest was passed
  | 'iitj_lecture' // an IITJ lecture was watched
  | 'iitj_submit' // an IITJ assignment / quiz was submitted
  | 'activity'; // heartbeat from the player or the tab (keeps the session from drifting)

export type EventSource = 'app' | 'tutor' | 'claude' | 'cli' | 'mcp' | 'test' | 'hub' | 'lab';

export interface StudyEvent {
  seq: number;
  at: number;
  kind: EventKind;
  concept?: string;
  session?: string;
  source: EventSource;
  data: Record<string, unknown>;
}

export type MistakeClass = 'concept_gap' | 'formula_recall' | 'wrong_method' | 'calculation' | 'notation' | 'misread' | 'incomplete' | 'confusion';
export const MISTAKE_CLASSES: MistakeClass[] = ['concept_gap', 'formula_recall', 'wrong_method', 'calculation', 'notation', 'misread', 'incomplete', 'confusion'];
export const MISTAKE_LABEL: Record<MistakeClass, string> = {
  concept_gap: 'concept gap',
  formula_recall: 'formula recall',
  wrong_method: 'wrong method',
  calculation: 'calculation slip',
  notation: 'notation',
  misread: 'misread the question',
  incomplete: 'incomplete answer',
  confusion: 'confused with another concept',
};

// ---------- ladder and mastery ----------

export type Rung = 'none' | 'seen' | 'understood' | 'applied' | 'retained' | 'exam_ready';
export const RUNGS: Rung[] = ['none', 'seen', 'understood', 'applied', 'retained', 'exam_ready'];
export const RUNG_LABEL: Record<Rung, string> = { none: 'Not started', seen: 'Seen', understood: 'Understood', applied: 'Applied', retained: 'Retained', exam_ready: 'Exam-ready' };
export const rungIndex = (r: Rung) => RUNGS.indexOf(r);

/** The mastery dimensions kept per concept (0..1 each, null = no evidence yet). */
export interface Mastery {
  exposure: number | null; // share of the resource path completed
  understanding: number | null; // best explanation coverage of the key points
  recall: number | null; // quick-check accuracy (latest answer per question)
  application: number | null; // test items answered correctly (numerical / derivation)
  implementation: number | null; // share of hidden lab tests passed (best run)
  retention: number | null; // FSRS retrievability now
  transfer: number | null; // transfer questions answered correctly
  speed: number | null; // timed-test items answered correctly
}

export interface ConceptState {
  concept: string;
  rung: Rung;
  reachedAt: Partial<Record<Rung, number>>; // when each rung was first reached
  mastery: Mastery;
  nextStep: 'watch' | 'explain' | 'quick' | 'lab' | 'review' | 'test' | 'done';
  missedChecks: number; // failed explain / quick-check rounds since the last pass (alternate segment after one)
}

export interface Repair {
  key: string; // concept|class|detail
  concept: string;
  cls: MistakeClass;
  detail: string;
  count: number;
  openedAt: number;
  lastAt: number;
}

export interface FsrsCard {
  stability: number; // days
  difficulty: number; // 1..10
  last: number; // ms of the last review
  due: number; // ms
  reps: number;
  lapses: number;
}

// ---------- queue ----------

export type QueueItem =
  | { kind: 'repair'; concept: string; title: string; subject: string; why: string; repair: Repair; minutes: number }
  | { kind: 'review'; concept: string; title: string; subject: string; why: string; due: number; minutes: number }
  | { kind: 'test'; testId: string; title: string; why: string; minutes: number }
  | { kind: 'learn'; concept: string; title: string; subject: string; why: string; step: ConceptState['nextStep']; segment?: Segment; minutes: number };

// ---------- progress ----------

export interface SubjectProgress {
  subject: string;
  title: string;
  concepts: number;
  applied: number; // at Applied or above
  coverage: number; // 0..1
  released: number;
  releasedApplied: number;
  releasedCoverage: number;
  readiness: number; // 0..1
}

export interface Progress {
  date: string;
  examStart: string;
  readyBy: string;
  daysToExam: number;
  daysToReady: number;
  coverage: number;
  releasedCoverage: number;
  readiness: number;
  iitjTrack: number; // 0..1
  iitj: { lectures: number; lecturesWatched: number; assignments: number; assignmentsSubmitted: number };
  pace: { status: 'ahead' | 'on_pace' | 'behind' | 'no_data'; neededPerDay: number; averagePerDay: number; behindBy: number; remaining: number };
  projectedReady: string | null;
  subjects: SubjectProgress[];
  studyMinutesToday: number;
  studyMinutesTotal: number;
  reorderedByWeight: boolean; // the projected date slipped past readyBy
}

// ---------- tests ----------

export type TestBucket = 'new' | 'retention' | 'mistake' | 'transfer';

export interface TestItem {
  id: string;
  subject: string;
  concepts: string[];
  bucket: TestBucket;
  style?: 'iitj';
  kind: QuestionKind;
  q: string;
  marks: number;
  rubric?: { point: string; marks: number }[]; // written: fixed before the test is released
  answer?: string; // model answer (never shown before grading)
  transfer?: boolean;
  entry?: string; // programming
  starter?: string;
  tests?: string; // programming: hidden tests, relative to the vault (never served to the taker)
}

export interface TestPaper {
  id: string; // date key
  title: string;
  createdAt: string;
  durationMin: number;
  released: boolean;
  covers: { subject: string; concepts: string[] }[];
  items: TestItem[];
  file: string;
}

export interface TestGrading {
  test: string;
  items: { id: string; marks: number; feedback?: string; mistakes?: { concept: string; cls: MistakeClass; detail?: string }[] }[];
  reviewNotes?: Record<string, string>; // programming: Claude's review of method and clarity
  file: string;
}

export interface TestReport {
  test: string;
  at: number;
  total: { marks: number; max: number; pct: number };
  subjects: { subject: string; marks: number; max: number; pct: number }[];
  moved: { concept: string; from: Rung; to: Rung }[];
  mistakes: { cls: MistakeClass; count: number }[];
  repairsAdded: string[];
  coverage: number;
  readiness: number;
  projectedReady: string | null;
}

// ---------- quick tutor ----------

export interface ExplainVerdict {
  covered: string[]; // key point ids
  missed: string[];
  wrong: { id: string; why: string }[];
  feedback: string; // 2–3 lines
  mistakes: { cls: MistakeClass; detail?: string }[];
  coverage: number; // covered / key points
  pass: boolean;
  confidence: 'high' | 'low';
}

export interface AnswerVerdict {
  questionId: string;
  correct: boolean;
  feedback: string;
  mistake?: { cls: MistakeClass; detail?: string };
  confidence: 'high' | 'low';
}
