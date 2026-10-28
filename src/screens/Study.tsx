import { BookOpen, Camera, Check as CheckIcon, ChevronLeft, ChevronRight, CircleAlert, ExternalLink, FlaskConical, GraduationCap, Inbox, Mic, Play, RefreshCw, Square, Undo2, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, Choice, Disclosure, Field, Steps } from '../components/ui';
import { fmtTime } from '../core/study/ids';
import { RUNG_LABEL, type QueueItem, type Rung, type Segment, type SubjectProgress } from '../core/study/types';
import { cacheGet, cacheSet, enqueue, flushQueue, queued, StudyApiError, studyCall, youtubeId } from '../lib/studyApi';
import { useStore } from '../state/store';
import { useNow } from '../state/runtime';
import { isCapacitor } from '../lib/platform';
import { CreateVault, StudySetup } from './StudySetup';
import { StudyGraph } from './StudyGraph';
import { appendSpoken, listen, speechMode, type Listening, type SpeechMode } from '../lib/speech';

// The Study tab: open it, see the next video. Everything here comes from the hub on the PC; offline it
// shows the last pack it saved (next 3 items, their checks, due reviews) and queues answers.

interface Overview {
  setup: { assessment: boolean; concepts: number; subjects: number };
  header: { daysToExam: number; daysToReady: number; readyBy: string; examStart: string; coverage: number; readiness: number; pace: { status: string; behindBy: number; neededPerDay: number; averagePerDay: number }; projectedReady: string | null } | null;
  next: QueueItem | null;
  due: { reviews: QueueItem[]; repairs: QueueItem[]; test: QueueItem | null };
  subjects: SubjectProgress[];
  iitj: { track: number; lectures: number; lecturesWatched: number; assignments: number; assignmentsSubmitted: number; deadlines: { id: string; subject: string; title: string; due: string; graded: boolean }[] } | null;
  studyMinutesToday: number;
  live: { id: string; concept: string | null; since: number; kind: string } | null;
  lastTest: { id: string; status: string } | null;
  jobs: { job: string; ok: boolean; ended: number; log: string | null }[];
  errors: number;
}

interface ConceptView {
  concept: { id: string; title: string; subject: string; definition?: string; body?: string; formulas: { id: string; latex: string; name?: string }[]; notation: { iitj: string; resource: string; meaning?: string }[] };
  state: { rung: Rung; nextStep: string; missedChecks: number; mastery: Record<string, number | null> };
  path: { segments: Segment[]; alternates: Segment[] } | null;
  pack: { keyPoints: number; questions: { id: string; q: string; kind: string; options?: string[] }[]; hints: string[]; formulas: string[] } | null;
  lab: { id: string; title: string; task: string; entry: string; starter: string } | null;
  hintsOnly: boolean;
  repairs: { key: string; cls: string; detail: string }[];
  visual: Segment | null;
}

const pct = (n: number | null | undefined) => `${Math.round((n ?? 0) * 100)}%`;
const PACE: Record<string, string> = { ahead: 'ahead of pace', on_pace: 'on pace', behind: 'behind', no_data: 'pace from day 2' };
const KIND_LABEL: Record<QueueItem['kind'], string> = { learn: 'New lesson', review: 'Quick recall', repair: 'Fix a weak spot', test: '3-day test' };

/** The header in one plain sentence: days left and where the plan stands. */
function paceLine(h: NonNullable<Overview['header']>) {
  const p = h.pace;
  const pace =
    p.status === 'behind' && p.behindBy > 0
      ? `${p.behindBy} topic${p.behindBy === 1 ? '' : 's'} behind the plan`
      : p.status === 'ahead'
        ? 'ahead of the plan'
        : p.status === 'no_data'
          ? 'your pace shows from day 2'
          : 'on plan';
  return `${h.daysToExam} days to the exam · ${pace}`;
}

function useOnline() {
  const [online, set] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => {
    const on = () => set(true);
    const off = () => set(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function Study() {
  const toast = useStore((s) => s.toast);
  const summary = useStore((s) => s.doc.study?.summary);
  const [ov, setOv] = useState<Overview | null>(() => cacheGet<Overview>('overview'));
  const [err, setErr] = useState<{ msg: string; status: number; setup?: boolean } | null>(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState<{ concept: string; repair?: string } | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(() => (location.hash.startsWith('#study/session/') ? location.hash.slice('#study/session/'.length) : null));
  // "Start lesson" on the Now tab links here (#study/next): start today's lesson once the overview is in
  const wantNext = useRef(location.hash === '#study/next');
  const online = useOnline();

  const load = useCallback(async () => {
    try {
      const sent = queued().length ? await flushQueue() : 0;
      if (sent) toast(`${sent} saved answer${sent > 1 ? 's' : ''} sent to the PC`, 'success');
      const o = await studyCall<Overview>('overview');
      setOv(o);
      setErr(null);
      setOffline(false);
      cacheSet('overview', o);
      // keep today's pack for offline use
      void studyCall('offlinePack').then((p) => cacheSet('pack', p)).catch(() => {});
    } catch (e) {
      const x = e as StudyApiError;
      if (x.status === 0) setOffline(true);
      else setErr({ msg: x.message, status: x.status, setup: x.body?.setup === false });
    }
  }, [toast]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load, online]);

  const live = ov?.live ?? null;
  useEffect(() => {
    if (!live) return;
    // keep the session from being marked as drift while the tab is in use
    const beat = () => document.visibilityState === 'visible' && void studyCall('activity').catch(() => {});
    const t = window.setInterval(beat, 120_000);
    return () => window.clearInterval(t);
  }, [live]);

  const stop = async () => {
    try {
      const r = await studyCall<{ line: string; minutes: number }>('stop');
      toast(`Session saved · ${r.minutes} min · ${r.line}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'warn');
    }
    void load();
  };
  const startTimer = async (concept?: string) => {
    try {
      const r = await studyCall<{ label: string; focusGuard?: boolean }>('start', { concept });
      const what = r.label.replace(/^Studying: /, '').replace(/ \(Study OS\)$/, '');
      toast(`Timer on — ${what}${r.focusGuard ? ' · Focus Guard is on' : ''}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'warn');
    }
    void load();
  };
  /** One tap: the timer (and Focus Guard) starts and the lesson opens. A lesson already running just reopens. */
  const startLesson = async (concept: string, repair?: string) => {
    setOpen({ concept, repair });
    if (live?.concept !== concept) await startTimer(concept);
  };

  useEffect(() => {
    if (!wantNext.current || !ov) return;
    wantNext.current = false;
    history.replaceState(null, '', location.pathname);
    const n = ov.next;
    if (ov.live?.concept) setOpen({ concept: ov.live.concept });
    else if (n && 'concept' in n) void startLesson(n.concept, n.kind === 'repair' ? n.repair.key : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov]);

  if (session) return <SessionReport id={session} onClose={() => (setSession(null), history.replaceState(null, '', location.pathname))} />;
  if (test) return <TestTaking id={test} onClose={() => (setTest(null), void load())} />;
  if (open)
    return (
      <ConceptWork
        {...open}
        live={live}
        onStart={() => void startTimer(open.concept)}
        onStop={() => void stop()}
        onClose={() => (setOpen(null), void load())}
      />
    );

  const next = ov?.next ?? null;
  const liveTitle = live && next && 'concept' in next && next.concept === live.concept ? next.title : undefined;

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Study</h1>
          <p>{ov?.header ? paceLine(ov.header) : 'Study OS · your vault on the PC'}</p>
        </div>
        <div className="row wrap">
          {(offline || !online) && (
            <span className="chip">
              <WifiOff size={13} /> offline — saved pack
            </span>
          )}
          <button className="btn ghost sm icon" aria-label="Refresh" title="Refresh" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {live && <LiveBar live={live} title={liveTitle} onStop={() => void stop()} onOpen={live.concept ? () => setOpen({ concept: live.concept! }) : undefined} />}
      {err && (err.setup ? <CreateVault onDone={() => void load()} /> : <SetupHelp err={err} />)}
      {!ov && !err && summary && <SummaryOnly summary={summary} />}
      {!ov && !err && !summary && <div className="empty">Connecting to your PC…</div>}

      {ov && (
        <div className="stack lg">
          {ov.jobs.filter((j) => !j.ok).map((j) => (
            <div key={j.job} className="banner" data-tone="drifting">
              <CircleAlert size={18} />
              <div className="grow">
                <h3>The last {j.job} job failed</h3>
                <p>{j.log ? `Log: ${j.log}` : 'See study jobs on the PC.'} Run it again by hand: study run-job {j.job} --force</p>
              </div>
            </div>
          ))}
          {!ov.setup.assessment && (
            <div className="empty">
              <strong>Add your exam dates first</strong>Fill semesters/s1/assessment.yaml in the vault (Study setup below). Exam dates, subjects and weights decide the pace and the ready date.
            </div>
          )}

          <NextUp item={next} subjects={ov.subjects} live={live} onStart={(c, r) => void startLesson(c, r)} onPreview={(c, r) => setOpen({ concept: c, repair: r })} onTest={setTest} />
          <DueFirst due={ov.due} onTest={setTest} onFix={(c, r) => void startLesson(c, r)} onReload={() => void load()} />
          <Progress subjects={ov.subjects} header={ov.header} minutesToday={ov.studyMinutesToday} />
          {ov.iitj && <IitjTrack iitj={ov.iitj} onDone={() => void load()} />}
          <Extras lastTest={ov.lastTest} subjects={ov.subjects} onReport={(id) => setSession(`test:${id}`)} onReload={() => void load()} onOpen={(c) => setOpen({ concept: c })} />
          <StudySetup subjects={ov.subjects} onChanged={() => void load()} />
        </div>
      )}
    </div>
  );
}

/** The running session, always visible: what is being timed, for how long, and how to finish it. */
function LiveBar({ live, title, onStop, onOpen }: { live: NonNullable<Overview['live']>; title?: string; onStop: () => void; onOpen?: () => void }) {
  const now = useNow();
  const min = Math.max(0, Math.floor((now - live.since) / 60_000));
  return (
    <div className="live-bar" role="status">
      <span className="dot" aria-hidden="true" />
      <span className="grow">
        Timer running{title ? <> · <strong>{title}</strong></> : ''} · {min} min
      </span>
      {onOpen && (
        <button className="btn sm ghost" onClick={onOpen}>
          Open lesson
        </button>
      )}
      <button className="btn sm" onClick={onStop}>
        <Square size={13} /> Finish
      </button>
    </div>
  );
}

function SetupHelp({ err }: { err: { msg: string; status: number; setup?: boolean } }) {
  return (
    <div className="empty">
      <strong>{err.setup ? 'Create your Study Vault on the PC' : err.status === 404 ? 'Study OS is off on the PC' : 'Study OS could not answer'}</strong>
      <span>{err.msg}</span>
      {err.setup && <code className="mono">npm run study -- init C:\StudyOS</code>}
    </div>
  );
}

/** Offline and never loaded: the small synced summary is all this device has. */
function SummaryOnly({ summary }: { summary: NonNullable<ReturnType<typeof useStore.getState>['doc']['study']>['summary'] }) {
  if (!summary) return null;
  return (
    <section className="card">
      <h2 className="card-title">From your PC (synced summary)</h2>
      <dl className="kv">
        <dt>Next</dt>
        <dd>{summary.next ? `${summary.next.concept} · ${summary.next.subject} · ${summary.next.minutes} min` : '—'}</dd>
        <dt>Covered</dt>
        <dd>{pct(summary.coverage)}</dd>
        <dt>Pace</dt>
        <dd>{PACE[summary.pace] ?? summary.pace}</dd>
        <dt>Ready by</dt>
        <dd>
          {summary.readyBy} (projected {summary.projectedReady ?? 'unknown'})
        </dd>
      </dl>
    </section>
  );
}

/** Today's lesson: one primary action. */
function NextUp({
  item,
  subjects,
  live,
  onStart,
  onPreview,
  onTest,
}: {
  item: QueueItem | null;
  subjects: SubjectProgress[];
  live: Overview['live'];
  onStart: (concept: string, repair?: string) => void;
  onPreview: (concept: string, repair?: string) => void;
  onTest: (testId: string) => void;
}) {
  if (!item)
    return (
      <div className="empty">
        <strong>Nothing queued yet</strong>
        <span>Add your course material on the PC (Study setup → assets, then let the nightly ingest run) and your next lesson appears here.</span>
      </div>
    );
  if (item.kind === 'test')
    return (
      <section className="card study-hero">
        <h2 className="card-title">
          Today <span className="pill" data-tone="warn">{KIND_LABEL.test}</span>
        </h2>
        <h3>{item.title}</h3>
        <p className="muted" style={{ margin: '0 0 14px' }}>
          {item.minutes} min · written + programming · the clock cannot be paused
        </p>
        <button className="btn primary lg" onClick={() => onTest(item.testId)}>
          <Play size={16} /> Take the test
        </button>
      </section>
    );
  const seg = item.kind === 'learn' ? item.segment : undefined;
  const repair = item.kind === 'repair' ? item.repair.key : undefined;
  const running = live?.concept === item.concept;
  return (
    <section className="card study-hero">
      <h2 className="card-title">
        Today's lesson <span className="pill" data-tone={item.kind === 'repair' ? 'warn' : undefined}>{KIND_LABEL[item.kind]}</span>
      </h2>
      <h3>{item.title}</h3>
      <p className="muted" style={{ margin: '0 0 10px' }}>
        {subjects.find((s) => s.subject === item.subject)?.title ?? item.subject} · about {item.minutes} min
      </p>
      {seg && <SegmentLine seg={seg} />}
      <p className="faint" style={{ margin: '8px 0 0', fontSize: 13 }}>
        Why now: {item.why}
      </p>
      <div className="btn-row" style={{ marginTop: 16 }}>
        <button className="btn primary lg" onClick={() => onStart(item.concept, repair)}>
          <Play size={16} /> {running ? 'Continue lesson' : 'Start lesson'}
        </button>
        {!running && (
          <button className="btn ghost" onClick={() => onPreview(item.concept, repair)}>
            <BookOpen size={15} /> Preview without the timer
          </button>
        )}
      </div>
      {!running && (
        <p className="faint" style={{ margin: '8px 0 0', fontSize: 12 }}>
          Start lesson turns the study timer and Focus Guard on, then walks you through watch → explain → check.
        </p>
      )}
    </section>
  );
}

function SegmentLine({ seg }: { seg: Segment }) {
  return (
    <p style={{ margin: 0, fontSize: 14 }}>
      <strong>{seg.source}</strong>
      {seg.course ? ` · ${seg.course}` : ''}
      {seg.lecture ? ` · ${seg.lecture}` : ''}
      {seg.start !== undefined && seg.end !== undefined && seg.timestampVerified !== false ? ` · ${fmtTime(seg.start)}–${fmtTime(seg.end)}` : seg.pages ? ` · pages ${seg.pages}` : ''}
      {seg.timestampVerified === false && (
        <span className="chip" title={seg.verifyNote} style={{ marginLeft: 6, color: 'var(--warn)' }}>
          times not verified · whole video
        </span>
      )}
      <br />
      <span className="faint">{seg.why}</span>
    </p>
  );
}

/** Reviews, weak spots and a due test — shown only when something is actually due. */
function DueFirst({ due, onTest, onFix, onReload }: { due: Overview['due']; onTest: (testId: string) => void; onFix: (concept: string, repair?: string) => void; onReload: () => void }) {
  const repairs = due.repairs.filter((r) => 'concept' in r);
  const reviews = due.reviews.filter((r) => 'concept' in r);
  const test = due.test && 'testId' in due.test ? due.test : null;
  const n = (test ? 1 : 0) + repairs.length + reviews.length;
  if (!n) return null;
  return (
    <section className="card">
      <h2 className="card-title">
        Do these first <span className="pill" data-tone="warn">{n} due</span>
      </h2>
      <div>
        {test && (
          <div className="list-row">
            <div className="grow">
              <strong style={{ fontWeight: 500 }}>{test.title}</strong>
              <div className="faint" style={{ fontSize: 13 }}>
                {test.minutes} min, written + programming
              </div>
            </div>
            <button className="btn primary sm" onClick={() => onTest(test.testId)}>
              Take the test
            </button>
          </div>
        )}
        {repairs.map(
          (r) =>
            'concept' in r && (
              <div key={`r-${r.concept}`} className="list-row">
                <div className="grow">
                  <strong style={{ fontWeight: 500 }}>Fix a weak spot · {r.title}</strong>
                  <div className="faint" style={{ fontSize: 13 }}>
                    {r.why}
                  </div>
                </div>
                <button className="btn sm" onClick={() => onFix(r.concept, r.kind === 'repair' ? r.repair.key : undefined)}>
                  Fix it
                </button>
              </div>
            ),
        )}
        {reviews.map((r) => 'concept' in r && <ReviewRow key={`v-${r.concept}`} concept={r.concept} title={r.title} why={r.why} onDone={onReload} />)}
      </div>
    </section>
  );
}

function Progress({ subjects, header, minutesToday }: { subjects: SubjectProgress[]; header: Overview['header']; minutesToday: number }) {
  return (
    <section className="card">
      <h2 className="card-title">
        Progress <span>{minutesToday} min studied today</span>
      </h2>
      <div className="stack">
        {subjects.map((s) => (
          <div key={s.subject}>
            <div className="row between wrap" style={{ fontSize: 14 }}>
              <span style={{ fontWeight: 500 }}>{s.title}</span>
              <span className="faint">
                {s.applied} of {s.concepts} topics learned
              </span>
            </div>
            <div className="study-bar">
              <Bar value={s.coverage} color="var(--accent)" />
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              {pct(s.coverage)} covered · {pct(s.readiness)} exam-ready
            </div>
          </div>
        ))}
        {!subjects.length && <p className="muted">No subjects yet — add a syllabus in Study setup.</p>}
        {header && (
          <p className="faint" style={{ margin: 0, fontSize: 13 }}>
            Aim: everything learned by {header.readyBy}
            {header.projectedReady ? ` · at today's pace you finish ${header.projectedReady}` : ''}
            {header.pace.neededPerDay ? ` · about ${Math.ceil(header.pace.neededPerDay)} topic${Math.ceil(header.pace.neededPerDay) === 1 ? '' : 's'} a day needed` : ''}
          </p>
        )}
      </div>
    </section>
  );
}

/** The embedded player: starts and stops at the chosen timestamps and reports completion. */
function Player({ seg, onEnded }: { seg: Segment; onEnded: () => void }) {
  const id = youtubeId(seg.url);
  const ref = useRef<HTMLIFrameElement>(null);
  const ended = useRef(false);
  useEffect(() => {
    if (!id) return;
    const onMsg = (e: MessageEvent) => {
      if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin).hostname)) return;
      try {
        const d = typeof e.data === 'string' ? (JSON.parse(e.data) as { event?: string; info?: unknown }) : e.data;
        const state = d?.event === 'onStateChange' ? d.info : (d?.info as { playerState?: number } | undefined)?.playerState;
        if (state === 1) void studyCall('activity').catch(() => {});
        if (state === 0 && !ended.current) {
          ended.current = true;
          onEnded();
        }
      } catch {
        /* not a player message */
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [id, onEnded]);
  if (!id) return <Reader seg={seg} />;
  // times are used only when the video's own transcript / chapters back them; otherwise the whole video plays
  const timed = seg.timestampVerified !== false;
  const q = new URLSearchParams({ enablejsapi: '1', rel: '0', modestbranding: '1', origin: location.origin.startsWith('http') ? location.origin : 'https://localhost', ...(timed && seg.start !== undefined ? { start: String(seg.start) } : {}), ...(timed && seg.end !== undefined ? { end: String(seg.end) } : {}) });
  return (
    <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 10, overflow: 'hidden', background: '#000' }}>
      <iframe
        ref={ref}
        title={seg.lecture ?? seg.source}
        src={`https://www.youtube-nocookie.com/embed/${id}?${q}`}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
        onLoad={() => ref.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'study', channel: 'widget' }), '*')}
      />
    </div>
  );
}

/**
 * A non-YouTube resource (course page, interactive site, PDF) inside the Study tab when the site allows it
 * (the hub checks its headers); otherwise it opens in the browser. Either way "Done" below records it.
 */
function Reader({ seg }: { seg: Segment }) {
  const [v, setV] = useState<{ embeddable: boolean; pdf: boolean; reason: string } | null>(null);
  useEffect(() => {
    setV(null);
    studyCall<{ embeddable: boolean; pdf: boolean; reason: string }>('frameCheck', { url: seg.url }).then(setV, () => setV({ embeddable: false, pdf: false, reason: 'the PC could not check this link' }));
  }, [seg.url]);
  // Android's WebView cannot draw PDFs inside a page: those open in the phone's viewer
  const inApp = !!v?.embeddable && !(v.pdf && isCapacitor);
  const open = () => window.open(seg.url, '_blank', 'noopener');
  return (
    <div>
      {inApp ? (
        <div style={{ position: 'relative', height: '70vh', borderRadius: 10, overflow: 'hidden', border: '1px solid var(--line)', background: '#fff' }}>
          <iframe title={seg.source} src={seg.url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerPolicy="no-referrer" style={{ width: '100%', height: '100%', border: 0 }} />
        </div>
      ) : (
        <div className="empty">
          <strong>{v ? `${seg.source} opens in your browser` : 'Checking the link…'}</strong>
          {v && <span className="faint">{v.reason}. Study it there, then come back and press Done.</span>}
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={open}>
          <ExternalLink size={14} /> {inApp ? 'Open in browser instead' : `Open ${seg.source}`}
          {seg.pages ? ` (pages ${seg.pages})` : ''}
        </button>
      </div>
    </div>
  );
}

type StepId = 'watch' | 'explain' | 'check' | 'lab' | 'done';
const STEP_LABEL: Record<StepId, string> = { watch: 'Watch', explain: 'Explain', check: 'Check', lab: 'Lab', done: 'Done' };
const MASTERY_LABEL: Record<string, string> = {
  exposure: 'Watched',
  understanding: 'Explained',
  recall: 'Recall',
  application: 'Problems',
  implementation: 'Code',
  retention: 'Memory',
  transfer: 'New situations',
  speed: 'Speed',
};

/**
 * A guided lesson: watch → explain → check → (lab) → done, one step on screen at a time. Every step stays
 * reachable from the step bar; "Next" never blocks, it only suggests the order that makes the learning stick.
 */
function ConceptWork({ concept, repair, live, onStart, onStop, onClose }: { concept: string; repair?: string; live: Overview['live']; onStart: () => void; onStop: () => void; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [v, setV] = useState<ConceptView | null>(() => (cacheGet<{ items: { view: ConceptView }[] }>('pack')?.items.find((i) => i.view.concept.id === concept)?.view ?? null));
  const [segIndex, setSegIndex] = useState(0);
  const [step, setStep] = useState<StepId | null>(null);
  const [finished, setFinished] = useState<StepId[]>([]);
  const load = useCallback(() => studyCall<ConceptView>('concept', { id: concept }).then(setV).catch((e: Error) => toast(e.message, 'warn')), [concept, toast]);
  useEffect(() => void load(), [load]);
  if (!v) return <div className="empty">Loading the lesson…</div>;
  const alt = v.state.missedChecks > 0 && v.path?.alternates.length ? v.path.alternates : null;
  const segs = repair && v.visual ? [v.visual] : (alt ?? v.path?.segments ?? []);
  const seg = segs[Math.min(segIndex, segs.length - 1)];
  const steps: StepId[] = [...(seg ? (['watch'] as const) : []), ...(v.pack && !repair ? (['explain'] as const) : []), ...(v.pack ? (['check'] as const) : []), ...(v.lab && !repair ? (['lab'] as const) : []), 'done'];
  const m = v.state.mastery;
  const isDone = (s: StepId) =>
    finished.includes(s) ||
    (!repair && s === 'watch' && (m.exposure ?? 0) >= 0.99) ||
    (s === 'explain' && (m.understanding ?? 0) > 0) ||
    (!repair && s === 'check' && m.recall !== null && m.recall !== undefined) ||
    (s === 'lab' && (m.implementation ?? 0) > 0);
  const first = repair ? steps[0] : (steps.find((s) => s !== 'done' && !isDone(s)) ?? steps[0]);
  const current = step && steps.includes(step) ? step : first;
  const idx = steps.indexOf(current);
  const go = (i: number) => {
    setStep(steps[Math.max(0, Math.min(steps.length - 1, i))]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const complete = (s: StepId) => setFinished((x) => (x.includes(s) ? x : [...x, s]));
  const stepLabel = (s: StepId) => (s === 'check' && repair ? 'Retest' : STEP_LABEL[s]);
  const running = live?.concept === concept;

  const watched = async (s: Segment) => {
    const params = { concept, url: s.url, alternate: !!alt, index: segIndex };
    try {
      await studyCall('segment', params);
      toast('Marked as watched', 'success');
      void load();
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) {
        enqueue('segment', params);
        toast('Saved — it is sent when the PC is reachable', 'info');
      } else return toast((e as Error).message, 'warn');
    }
    if (segIndex < segs.length - 1) setSegIndex(segIndex + 1);
    else {
      complete('watch');
      go(idx + 1);
    }
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <button className="btn ghost sm" onClick={onClose} style={{ marginLeft: -10, marginBottom: 6 }}>
            <ChevronLeft size={15} /> All study
          </button>
          <h1>{v.concept.title}</h1>
          <p>
            {v.concept.subject} · stage: {RUNG_LABEL[v.state.rung]}
            {v.hintsOnly ? ' · a graded assignment is live: hints only' : ''}
          </p>
        </div>
      </header>

      {running && live ? (
        <LiveBar live={live} title={v.concept.title} onStop={onStop} />
      ) : (
        <div className="live-bar" style={{ background: 'var(--surface-2)' }}>
          <span className="grow">{live ? 'The timer is running for another lesson.' : 'The timer is off — this lesson does not count as study time.'}</span>
          <button className="btn sm primary" onClick={onStart}>
            <Play size={13} /> {live ? 'Time this lesson instead' : 'Start the timer'}
          </button>
        </div>
      )}

      {repair && (
        <div className="banner" data-tone="drifting" style={{ marginBottom: 16 }}>
          <CircleAlert size={18} />
          <div className="grow">
            <h3>Fixing a weak spot</h3>
            <p>Watch the clearest explanation, then answer the retest. It closes when you get it right.</p>
          </div>
        </div>
      )}

      {steps.length === 1 ? (
        <div className="empty">
          <strong>Nothing to study here yet</strong>
          <span>Tonight's curation adds a video or reading for this topic.</span>
        </div>
      ) : (
        <>
          <Steps steps={steps.map(stepLabel)} current={idx} done={(i) => isDone(steps[i])} onPick={go} />

          {current === 'watch' && seg && (
            <section className="card">
              <h2 className="card-title">
                {segs.length > 1 ? `Watch · part ${segIndex + 1} of ${segs.length}` : 'Watch'} {alt ? <span className="pill">another explanation</span> : null}
              </h2>
              <Player seg={seg} onEnded={() => void watched(seg)} />
              <div style={{ marginTop: 10 }}>
                <SegmentLine seg={seg} />
              </div>
              {(v.concept.definition || v.concept.formulas.length > 0 || v.concept.notation.length > 0) && (
                <div className="key-idea">
                  <strong>Key idea</strong>
                  {v.concept.definition && <p style={{ margin: '4px 0 0' }}>{v.concept.definition}</p>}
                  {v.concept.formulas.map((f) => (
                    <p key={f.id} className="mono" style={{ margin: '4px 0' }}>
                      {f.name ? `${f.name}: ` : ''}
                      {f.latex}
                    </p>
                  ))}
                  {v.concept.notation.length > 0 && <p className="faint" style={{ margin: '4px 0 0' }}>Notation: {v.concept.notation.map((n) => `IITJ ${n.iitj} = ${n.resource}${n.meaning ? ` (${n.meaning})` : ''}`).join(' · ')}</p>}
                </div>
              )}
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button className="btn primary" onClick={() => void watched(seg)}>
                  <CheckIcon size={15} /> {youtubeId(seg.url) ? 'I watched it' : 'I studied it'} — next
                </button>
              </div>
            </section>
          )}
          {current === 'explain' && v.pack && <Explain concept={concept} keyPoints={v.pack.keyPoints} onDone={(pass) => (void load(), pass && complete('explain'))} />}
          {current === 'check' && v.pack && <QuickCheck concept={concept} pack={v.pack} repair={repair} onAnswered={() => void load()} onComplete={() => complete('check')} />}
          {current === 'lab' && v.lab && <LabBox concept={concept} lab={v.lab} onDone={(ok) => (void load(), ok && complete('lab'))} />}
          {current === 'done' && (
            <section className="card">
              <h2 className="card-title">Lesson summary</h2>
              <div>
                {steps
                  .filter((s) => s !== 'done')
                  .map((s) => (
                    <div key={s} className="list-row">
                      <span>{stepLabel(s)}</span>
                      {isDone(s) ? (
                        <span className="pill" data-tone="ok">
                          done
                        </span>
                      ) : (
                        <button className="btn ghost sm" onClick={() => go(steps.indexOf(s))}>
                          Do it now
                        </button>
                      )}
                    </div>
                  ))}
              </div>
              <h2 className="card-title" style={{ marginTop: 20 }}>
                How well you know it <span>from your answers</span>
              </h2>
              <div className="stack">
                {Object.entries(m).map(([k, val]) => (
                  <div key={k} className="row mastery-row" style={{ fontSize: 13 }}>
                    <span style={{ width: 120 }}>{MASTERY_LABEL[k] ?? k}</span>
                    <span className="grow">{val === null ? <span className="faint">no evidence yet</span> : <Bar value={val} color="var(--accent)" />}</span>
                  </div>
                ))}
              </div>
              <div className="btn-row" style={{ marginTop: 18 }}>
                {running && (
                  <button className="btn primary" onClick={() => (onStop(), onClose())}>
                    <Square size={14} /> Finish the session
                  </button>
                )}
                <button className={`btn${running ? '' : ' primary'}`} onClick={onClose}>
                  Back to Study
                </button>
              </div>
            </section>
          )}
          {current !== 'done' && (
            <div className="lesson-nav">
              <button className="btn ghost" disabled={idx === 0} onClick={() => go(idx - 1)}>
                <ChevronLeft size={15} /> Back
              </button>
              <button className="btn" onClick={() => go(idx + 1)}>
                {isDone(current) ? 'Next' : 'Skip for now'} <ChevronRight size={15} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Explain({ concept, keyPoints, onDone }: { concept: string; keyPoints: number; onDone: (pass: boolean) => void }) {
  const toast = useStore((s) => s.toast);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ pass: boolean; coverage: number; feedback: string; covered: { text: string }[]; missed: { text: string }[]; hint?: string | null; confidence: string } | null>(null);
  // speech-to-text: native on the Android app, the browser's engine on the PC, otherwise typing only
  const [mode, setMode] = useState<SpeechMode>('none');
  const [session, setSession] = useState<Listening | null>(null);
  const [heard, setHeard] = useState('');
  useEffect(() => void speechMode().then(setMode), []);
  const speak = () => {
    const typedBefore = text;
    const l = listen(mode, setHeard);
    setSession(l);
    setHeard('');
    l.done
      .then((spoken) => setText(appendSpoken(typedBefore, spoken)))
      .catch((e: Error) => toast(e.message, 'warn'))
      .finally(() => {
        setSession(null);
        setHeard('');
      });
  };
  const check = async () => {
    setBusy(true);
    try {
      const r = await studyCall<NonNullable<typeof res>>('tutorExplain', { concept, text });
      setRes(r);
      onDone(r.pass);
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) {
        enqueue('tutorExplain', { concept, text });
        toast('Saved — the tutor checks it when the PC is reachable', 'info');
      } else toast((e as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  const short = 20 - text.trim().length;
  return (
    <section className="card">
      <h2 className="card-title">Explain it in your own words</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Teach it back as if to a friend{mode !== 'none' ? ' — type it or press Speak' : ''}. The tutor checks it against {keyPoints} key points.
      </p>
      <textarea className="textarea" rows={5} value={session ? appendSpoken(text, heard) : text} readOnly={!!session} onChange={(e) => setText(e.target.value)} placeholder={mode === 'none' ? 'Type your explanation…' : 'Type or speak your explanation…'} />
      {short > 0 && !session && (
        <small className="faint" style={{ display: 'block', marginTop: 4 }}>
          Write at least {short} more character{short === 1 ? '' : 's'} to check it.
        </small>
      )}
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !!session || short > 0} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Check my explanation'}
        </button>
        {mode !== 'none' &&
          (session ? (
            <button className="btn primary" onClick={() => session.stop()}>
              <Mic size={15} /> Listening… tap to stop
            </button>
          ) : (
            <button className="btn" onClick={speak}>
              <Mic size={15} /> Speak
            </button>
          ))}
      </div>
      {res && (
        <div className="banner" data-tone={res.pass ? 'info' : 'drifting'} style={{ marginTop: 12 }} role="status">
          {res.pass ? <CheckIcon size={18} /> : <CircleAlert size={18} />}
          <div className="grow">
            <h3>
              {res.pass ? 'Understood' : 'Not yet'} · {pct(res.coverage)} of the key points{res.confidence === 'low' ? ' (Claude re-checks tonight)' : ''}
            </h3>
            <p>{res.feedback}</p>
            {res.missed.length > 0 && <p>Missing: {res.missed.map((x) => x.text).join('; ')}</p>}
            {res.hint && <p>Hint: {res.hint} — the Watch step has another explanation.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function QuickCheck({ concept, pack, repair, onAnswered, onComplete }: { concept: string; pack: NonNullable<ConceptView['pack']>; repair?: string; onAnswered: () => void; onComplete: () => void }) {
  const toast = useStore((s) => s.toast);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, { correct: boolean; feedback: string }>>({});
  const total = pack.questions.length;
  const answered = pack.questions.filter((q) => results[q.id]).length;
  useEffect(() => {
    if (total && answered === total) onComplete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, total]);
  const send = async (qid: string) => {
    const params = { concept, question: qid, answer: answers[qid] ?? '', ...(repair ? { repair } : {}) };
    try {
      const r = await studyCall<{ correct: boolean; feedback: string }>('tutorAnswer', params);
      setResults((x) => ({ ...x, [qid]: r }));
      onAnswered();
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) {
        enqueue('tutorAnswer', params);
        setResults((x) => ({ ...x, [qid]: { correct: false, feedback: 'Saved offline — checked when the PC is reachable.' } }));
      } else toast((e as Error).message, 'warn');
    }
  };
  return (
    <section className="card">
      <h2 className="card-title">
        {repair ? 'Retest' : 'Quick check'}{' '}
        <span>
          {answered} of {total} answered
        </span>
      </h2>
      <div className="stack lg">
        {pack.questions.map((q, n) => {
          const r = results[q.id];
          return (
            <div key={q.id} className="qa">
              <div>
                <p style={{ margin: '0 0 8px' }}>
                  <span className="faint mono">{n + 1}. </span>
                  {q.q}
                </p>
                {q.options ? (
                  <Choice name={`q-${q.id}`} value={answers[q.id] ?? ''} options={q.options} onChange={(o) => setAnswers((a) => ({ ...a, [q.id]: o }))} />
                ) : (
                  <input className="input" style={{ width: '100%' }} aria-label={`Answer to question ${n + 1}`} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && answers[q.id]?.trim() && void send(q.id)} />
                )}
                <div className="btn-row" style={{ marginTop: 8 }}>
                  <button className="btn sm" disabled={!answers[q.id]?.trim()} onClick={() => void send(q.id)}>
                    {r ? 'Check again' : 'Check'}
                  </button>
                </div>
              </div>
              {r && (
                <div className="feedback" data-ok={String(r.correct)} role="status">
                  {r.correct ? <CheckIcon size={16} /> : <CircleAlert size={16} />}
                  <span>{r.feedback}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function LabBox({ concept, lab, onDone }: { concept: string; lab: NonNullable<ConceptView['lab']>; onDone: (ok: boolean) => void }) {
  const toast = useStore((s) => s.toast);
  const [code, setCode] = useState(lab.starter);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; passed: number; total: number; tests: { name: string; ok: boolean; error?: string }[]; error?: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await studyCall<NonNullable<typeof res>>('labRun', { lab: lab.id, code });
      setRes(r);
      onDone(r.ok);
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  void concept;
  return (
    <section className="card">
      <h2 className="card-title">
        <span>
          <FlaskConical size={13} /> Lab · {lab.title}
        </span>
      </h2>
      <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{lab.task}</p>
      <textarea className="textarea mono" rows={10} value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} />
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn primary sm" disabled={busy} onClick={() => void run()}>
          {busy ? 'Running on your PC…' : 'Run hidden tests'}
        </button>
      </div>
      {res && (
        <div style={{ marginTop: 10, fontSize: 14 }}>
          <strong style={{ color: res.ok ? 'var(--ok)' : 'var(--warn)' }}>
            {res.ok ? 'Passed' : 'Not yet'} · {res.passed}/{res.total}
          </strong>
          {res.error && <p className="faint">{res.error}</p>}
          {res.tests.map((t) => (
            <div key={t.name} className="faint">
              {t.ok ? '✓' : '✗'} {t.name}
              {t.error ? ` — ${t.error}` : ''}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewRow({ concept, title, why, onDone }: { concept: string; title: string; why: string; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [shown, setShown] = useState(false);
  const grade = async (g: number) => {
    const params = { kind: 'review', concept, data: { grade: g } };
    try {
      await studyCall('log', params);
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) enqueue('log', params);
      else return toast((e as Error).message, 'warn');
    }
    onDone();
  };
  return (
    <div className="list-row">
      <div className="grow">
        <strong style={{ fontWeight: 500 }}>Quick recall · {title}</strong>
        <div className="faint" style={{ fontSize: 13 }}>
          {shown ? 'How well did you remember it?' : `Say the idea to yourself from memory first. ${why}`}
        </div>
      </div>
      {!shown ? (
        <button className="btn sm" onClick={() => setShown(true)}>
          I've recalled it
        </button>
      ) : (
        <span className="btn-row">
          {['Forgot', 'Hard', 'Good', 'Easy'].map((l, i) => (
            <button key={l} className={`btn sm${i === 2 ? ' primary' : ''}`} onClick={() => void grade(i + 1)}>
              {l}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** Days from today to a YYYY-MM-DD date, in words, with a tone for the pill. */
function dueIn(due: string): { text: string; tone?: 'warn' | 'bad' } {
  const [y, mo, d] = due.split('-').map(Number);
  const t = new Date();
  const days = Math.round((new Date(y, mo - 1, d).getTime() - new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()) / 86_400_000);
  if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} late`, tone: 'bad' };
  if (days === 0) return { text: 'due today', tone: 'bad' };
  if (days === 1) return { text: 'due tomorrow', tone: 'warn' };
  return { text: `due in ${days} days`, tone: days <= 3 ? 'warn' : undefined };
}

function IitjTrack({ iitj, onDone }: { iitj: NonNullable<Overview['iitj']>; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const submit = (id: string, title: string) => {
    setBusy(id);
    void studyCall('deadlineSubmit', { id })
      .then(
        () => (toast(`${title} marked as submitted`, 'success'), onDone()),
        (e: Error) => toast(e.message, 'warn'),
      )
      .finally(() => setBusy(null));
  };
  return (
    <section className="card">
      <h2 className="card-title">
        IITJ deadlines{' '}
        <span>
          {iitj.lecturesWatched}/{iitj.lectures} lectures · {iitj.assignmentsSubmitted}/{iitj.assignments} submitted
        </span>
      </h2>
      <div>
        {!iitj.deadlines.length && <p className="muted" style={{ margin: 0 }}>No open deadlines.</p>}
        {iitj.deadlines.map((d) => {
          const due = dueIn(d.due);
          return (
            <div key={d.id} className="list-row">
              <div className="grow">
                <div>
                  <span style={{ fontWeight: 500 }}>{d.title}</span> <span className="faint">· {d.subject}</span>
                </div>
                <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                  <span className="pill" data-tone={due.tone} title={d.due}>
                    {due.text}
                  </span>
                  {d.graded && <span className="pill">graded — the tutor gives hints only</span>}
                </div>
              </div>
              <button className="btn sm" disabled={busy === d.id} onClick={() => submit(d.id, d.title)}>
                <CheckIcon size={14} /> Mark as submitted
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TestTaking({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [paper, setPaper] = useState<{ title: string; durationMin: number; items: { id: string; subject: string; kind: string; q: string; marks: number; style?: string; entry?: string; starter?: string }[] } | null>(null);
  const [answers, setAnswers] = useState<Record<string, { text?: string; code?: string; image?: string }>>({});
  const [deadline, setDeadline] = useState(0); // in this device's clock (server deadline, corrected for clock skew)
  const [now, setNow] = useState(Date.now());
  const [result, setResult] = useState<{ message: string; programming: { id: string; passed: number; total: number; marks: number; of: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(answers);
  latest.current = answers;
  const submitted = useRef(false);
  const warned = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    studyCall<{ paper: NonNullable<typeof paper>; deadline: number; now: number; draft: typeof answers }>('testStart', { id })
      .then((r) => {
        setPaper(r.paper);
        setDeadline(r.deadline + (Date.now() - r.now));
        const starters = Object.fromEntries(r.paper.items.filter((i) => i.kind === 'programming').map((i) => [i.id, { code: i.starter ?? '' }]));
        setAnswers({ ...starters, ...(r.draft ?? {}) }); // a reopened test continues where it was
      })
      .catch((e: Error) => toast(e.message, 'warn'));
  }, [id, toast]);
  const submit = useCallback(
    async (auto = false) => {
      if (submitted.current) return;
      submitted.current = true;
      setBusy(true);
      try {
        setResult(await studyCall('testSubmit', { id, answers: latest.current }));
        if (auto) toast('Time is up — your answers were submitted.', 'info');
      } catch (e) {
        submitted.current = false;
        toast((e as Error).message, 'warn');
      } finally {
        setBusy(false);
      }
    },
    [id, toast],
  );
  // the clock: a 1-minute warning, then submit automatically at zero
  useEffect(() => {
    if (!deadline || result) return;
    const t = window.setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (!warned.current && deadline - n <= 60_000) {
        warned.current = true;
        toast('1 minute left — your answers will be submitted automatically.', 'warn');
      }
      if (n >= deadline) void submit(true);
    }, 1000);
    return () => window.clearInterval(t);
  }, [deadline, result, submit, toast]);
  // autosave every 20 s: if this device dies, the PC submits the last saved answers when the time is up
  useEffect(() => {
    if (!deadline || result) return;
    const t = window.setInterval(() => {
      if (!dirty.current || submitted.current) return;
      dirty.current = false;
      void studyCall('testSave', { id, answers: latest.current }).catch(() => (dirty.current = true));
    }, 20_000);
    return () => window.clearInterval(t);
  }, [deadline, result, id]);
  useEffect(() => {
    dirty.current = true;
  }, [answers]);
  const left = deadline ? Math.max(0, deadline - now) : 0;
  const clock = `${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, '0')}`;
  const photo = (itemId: string, file: File) => {
    const r = new FileReader();
    r.onload = () => setAnswers((a) => ({ ...a, [itemId]: { ...a[itemId], image: String(r.result) } }));
    r.readAsDataURL(file);
  };
  if (!paper) return <div className="empty">Starting the test…</div>;
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{paper.title}</h1>
          <p>
            {paper.durationMin} min · Focus Guard is on · answers save automatically
          </p>
        </div>
        {!result && (
          <span className="chip mono" style={{ fontSize: 16, height: 32, color: left <= 60_000 ? 'var(--bad)' : undefined }} aria-live="polite">
            {clock} left
          </span>
        )}
        <button className="btn ghost sm" onClick={onClose}>
          Back
        </button>
      </header>
      {result ? (
        <section className="card">
          <h2 className="card-title">Submitted</h2>
          <p>{result.message}</p>
          {result.programming.map((p) => (
            <p key={p.id}>
              {p.id}: hidden tests {p.passed}/{p.total} → {p.marks}/{p.of}
            </p>
          ))}
          <button className="btn primary sm" onClick={onClose}>
            Done
          </button>
        </section>
      ) : (
        <div className="stack lg">
          {paper.items.map((it, n) => (
            <section key={it.id} className="card">
              <h2 className="card-title">
                {n + 1}. {it.subject} · {it.kind}
                {it.style === 'iitj' ? ' · IITJ style' : ''} <span>{it.marks} marks</span>
              </h2>
              <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{it.q}</p>
              {it.kind === 'programming' ? (
                <textarea className="textarea mono" rows={10} spellCheck={false} value={answers[it.id]?.code ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [it.id]: { code: e.target.value } }))} />
              ) : (
                <>
                  <textarea className="textarea" rows={5} value={answers[it.id]?.text ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [it.id]: { ...a[it.id], text: e.target.value } }))} placeholder="Type your answer, or upload a photo of your paper" />
                  <label className="btn sm" style={{ marginTop: 8 }}>
                    <Camera size={14} /> {answers[it.id]?.image ? 'Photo added' : 'Photo of paper answer'}
                    <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => e.target.files?.[0] && photo(it.id, e.target.files[0])} />
                  </label>
                </>
              )}
            </section>
          ))}
          <div className="btn-row">
            <button className="btn primary" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Running the hidden tests…' : 'Submit the test'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionReport({ id, onClose }: { id: string; onClose: () => void }) {
  const [r, setR] = useState<{ title: string; text: string } | null>(null);
  useEffect(() => {
    if (id.startsWith('test:')) {
      studyCall<{ markdown: string | null }>('testReport', { id: id.slice(5) })
        .then((x) => setR({ title: `Test ${id.slice(5)}`, text: x.markdown ?? 'No report yet.' }))
        .catch((e: Error) => setR({ title: 'Report', text: e.message }));
    } else {
      studyCall<{ label?: string; report: { line: string; minutes: number } }>('session', { id })
        .then((x) => setR({ title: x.label ?? 'Study session', text: `${x.report.minutes} min · ${x.report.line}` }))
        .catch((e: Error) => setR({ title: 'Study session', text: e.message }));
    }
  }, [id]);
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{r?.title ?? 'Report'}</h1>
        </div>
        <button className="btn ghost sm" onClick={onClose}>
          Back
        </button>
      </header>
      <section className="card">
        <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{r?.text ?? 'Loading…'}</pre>
      </section>
    </div>
  );
}

function Extras({ lastTest, subjects, onReport, onReload, onOpen }: { lastTest: Overview['lastTest']; subjects: SubjectProgress[]; onReport: (id: string) => void; onReload: () => void; onOpen: (concept: string) => void }) {
  const toast = useStore((s) => s.toast);
  const [props, setProps] = useState<{ id: string; title: string; client: string | null; payload: { rationale?: string } }[]>([]);
  const [changes, setChanges] = useState<{ seq: number; at: number; actor: string; action: string; undone: boolean }[]>([]);
  const [note, setNote] = useState('');
  const [graph, setGraph] = useState(false);
  const refresh = useCallback(() => {
    void studyCall<{ proposals: typeof props }>('proposals', { status: 'pending' }).then((r) => setProps(r.proposals), () => {});
    void studyCall<{ changes: typeof changes }>('changes').then((r) => setChanges(r.changes.slice(0, 5)), () => {});
  }, []);
  useEffect(() => refresh(), [refresh]);
  const act = (method: string, params: Record<string, unknown>, ok: string) =>
    void studyCall(method, params).then(
      () => (toast(ok, 'success'), refresh(), onReload()),
      (e: Error) => toast(e.message, 'warn'),
    );
  return (
    <>
      {props.length > 0 && (
        <section className="card">
          <h2 className="card-title">Suggested changes — your decision</h2>
          <div className="stack">
            {props.map((p) => (
              <div key={p.id} className="row between wrap">
                <span>
                  <strong>{p.title}</strong> <span className="faint">{p.client ? `from ${p.client}` : ''}{p.payload.rationale ? ` · ${p.payload.rationale}` : ''}</span>
                </span>
                <span className="btn-row">
                  <button className="btn primary sm" onClick={() => act('proposalApply', { id: p.id }, 'Applied — you can undo it below')}>
                    Apply
                  </button>
                  <button className="btn ghost sm" onClick={() => act('proposalReject', { id: p.id }, 'Rejected')}>
                    Reject
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      <Disclosure title="Tools" summary="Save a doubt · concept map · test reports · AI change history">
        <div className="stack">
          {lastTest && (
            <div className="row between">
              <span>
                Last 3-day test: {lastTest.id} ({lastTest.status})
              </span>
              {lastTest.status === 'graded' && (
                <button className="btn sm" onClick={() => onReport(lastTest.id)}>
                  Report
                </button>
              )}
            </div>
          )}
          <Field label="Save a doubt for later" hint="A question, a doubt or a link — the next ingest files it in the right subject.">
            <div className="row">
              <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Why is det(A − λI) = 0?" />
              <button className="btn sm" disabled={!note.trim()} onClick={() => (act('capture', { text: note }, 'Captured'), setNote(''))}>
                <Inbox size={14} /> Save
              </button>
            </div>
          </Field>
          <div className="row between">
            <span>Concept graph</span>
            <button className="btn ghost sm" onClick={() => setGraph(!graph)}>
              <GraduationCap size={14} /> {graph ? 'Hide' : 'Show'}
            </button>
          </div>
          {graph && <StudyGraph subjects={subjects} onOpen={onOpen} />}
          {changes.length > 0 && (
            <div>
              <strong style={{ fontSize: 13 }}>Recent AI changes to the vault</strong>
              {changes.map((c) => (
                <div key={c.seq} className="row between" style={{ fontSize: 13 }}>
                  <span className="faint">
                    {new Date(c.at).toLocaleString()} · {c.actor}: {c.action}
                  </span>
                  {!c.undone && (
                    <button className="btn ghost sm" onClick={() => act('undo', { seq: c.seq }, 'Undone')}>
                      <Undo2 size={13} /> Undo
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="faint" style={{ margin: 0 }}>
            The portfolio is generated weekly in your vault (portfolio/index.html) and stays private until you publish it.
          </p>
        </div>
      </Disclosure>
    </>
  );
}
