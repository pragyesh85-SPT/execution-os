import { BookOpen, Camera, Check as CheckIcon, CircleAlert, ExternalLink, FlaskConical, GraduationCap, Inbox, Mic, Play, RefreshCw, Square, Undo2, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, Field } from '../components/ui';
import { fmtTime } from '../core/study/ids';
import { RUNG_LABEL, type QueueItem, type Rung, type Segment, type SubjectProgress } from '../core/study/types';
import { cacheGet, cacheSet, enqueue, flushQueue, queued, StudyApiError, studyCall, youtubeId } from '../lib/studyApi';
import { useStore } from '../state/store';
import { CreateVault, StudySetup } from './StudySetup';
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
  const [open, setOpen] = useState<{ concept: string; repair?: string; review?: boolean } | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [session, setSession] = useState<string | null>(() => (location.hash.startsWith('#study/session/') ? location.hash.slice('#study/session/'.length) : null));
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

  const startStop = async (concept?: string) => {
    try {
      if (live) {
        const r = await studyCall<{ line: string; minutes: number }>('stop');
        toast(`Stopped after ${r.minutes} min · ${r.line}`, 'success');
      } else {
        const r = await studyCall<{ label: string }>('start', { concept });
        toast(`${r.label} — Focus Guard is on`, 'success');
      }
      void load();
    } catch (e) {
      toast((e as Error).message, 'warn');
    }
  };

  if (session) return <SessionReport id={session} onClose={() => (setSession(null), history.replaceState(null, '', location.pathname))} />;
  if (test) return <TestTaking id={test} onClose={() => (setTest(null), void load())} />;
  if (open) return <ConceptWork {...open} live={!!live} onStart={() => startStop(open.concept)} onClose={() => (setOpen(null), void load())} />;

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Study</h1>
          {ov?.header ? (
            <p>
              Exam in {ov.header.daysToExam} days · ready date in {ov.header.daysToReady} days · {pct(ov.header.coverage)} done · {PACE[ov.header.pace.status] ?? ov.header.pace.status}
              {ov.header.pace.behindBy ? ` by ${ov.header.pace.behindBy}` : ''}
            </p>
          ) : (
            <p>Study OS · your vault on the PC</p>
          )}
        </div>
        <div className="row wrap">
          {(offline || !online) && (
            <span className="chip">
              <WifiOff size={13} /> offline — saved pack
            </span>
          )}
          <button className={`btn sm${live ? ' primary' : ''}`} onClick={() => startStop(ov?.next && 'concept' in ov.next ? ov.next.concept : undefined)} disabled={!ov}>
            {live ? <Square size={14} /> : <Play size={14} />} {live ? 'Stop studying' : 'Start studying'}
          </button>
          <button className="btn ghost sm icon" aria-label="Refresh" onClick={() => void load()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {err && (err.setup ? <CreateVault onDone={() => void load()} /> : <SetupHelp err={err} />)}
      {!ov && !err && summary && <SummaryOnly summary={summary} />}
      {!ov && !err && !summary && <div className="empty">Connecting to your PC…</div>}

      {ov && (
        <div className="stack lg">
          {ov.jobs.filter((j) => !j.ok).map((j) => (
            <div key={j.job} className="banner" data-tone="drifting">
              <CircleAlert size={18} />
              <div className="grow">
                <h3>Last {j.job} failed</h3>
                <p>{j.log ? `Log: ${j.log}` : 'See study jobs on the PC.'} Run it again by hand: study run-job {j.job} --force</p>
              </div>
            </div>
          ))}
          {!ov.setup.assessment && <div className="empty"><strong>Fill semesters/s1/assessment.yaml in the vault</strong>Exam dates, subjects and weights decide the pace and the ready date.</div>}

          <NextUp item={ov.next} subjects={ov.subjects} live={!!live} onOpen={(c, repair) => setOpen({ concept: c, repair })} onStart={(c) => startStop(c)} />

          <section className="card">
            <h2 className="card-title">Due today</h2>
            <div className="stack">
              {ov.due.test && 'testId' in ov.due.test && (
                <div className="row between">
                  <span>
                    <strong>{ov.due.test.title}</strong> · {ov.due.test.minutes} min, written + programming
                  </span>
                  <button className="btn primary sm" onClick={() => setTest((ov.due.test as { testId: string }).testId)}>
                    Take the test
                  </button>
                </div>
              )}
              {ov.due.repairs.map((r) => 'concept' in r && (
                <div key={`r-${r.concept}`} className="row between">
                  <span>
                    <strong>Repair · {r.title}</strong> <span className="faint">{r.why}</span>
                  </span>
                  <button className="btn sm" onClick={() => setOpen({ concept: r.concept, repair: r.kind === 'repair' ? r.repair.key : undefined })}>
                    Fix it
                  </button>
                </div>
              ))}
              {ov.due.reviews.map((r) => 'concept' in r && <ReviewRow key={`v-${r.concept}`} concept={r.concept} title={r.title} why={r.why} onDone={() => void load()} />)}
              {!ov.due.test && !ov.due.repairs.length && !ov.due.reviews.length && <p className="muted" style={{ margin: 0 }}>Nothing due — go straight to the next video.</p>}
            </div>
          </section>

          <section className="card">
            <h2 className="card-title">Subjects</h2>
            <div className="stack">
              {ov.subjects.map((s) => (
                <div key={s.subject}>
                  <div className="row between" style={{ fontSize: 14 }}>
                    <span>{s.title}</span>
                    <span className="faint">
                      {s.applied}/{s.concepts} · coverage {pct(s.coverage)} · readiness {pct(s.readiness)}
                    </span>
                  </div>
                  <div className="study-bar">
                    <Bar value={s.coverage} color="var(--accent)" />
                  </div>
                  <div className="study-bar">
                    <Bar value={s.readiness} color="var(--ok)" />
                  </div>
                </div>
              ))}
              {!ov.subjects.length && <p className="muted">No subjects yet.</p>}
            </div>
          </section>

          {ov.iitj && <IitjTrack iitj={ov.iitj} onDone={() => void load()} />}
          <Extras lastTest={ov.lastTest} onReport={(id) => setSession(`test:${id}`)} onReload={() => void load()} />
          <StudySetup subjects={ov.subjects} onChanged={() => void load()} />
        </div>
      )}
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
        <dt>Coverage</dt>
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

function NextUp({ item, subjects, live, onOpen, onStart }: { item: QueueItem | null; subjects: SubjectProgress[]; live: boolean; onOpen: (concept: string, repair?: string) => void; onStart: (concept: string) => void }) {
  if (!item || !('concept' in item)) return <div className="empty">Nothing queued yet. Ingest the assets on the PC (study ingest) and let /ingest run.</div>;
  const seg = item.kind === 'learn' ? item.segment : undefined;
  return (
    <section className="card">
      <h2 className="card-title">
        Next up <span className="chip">{item.kind === 'repair' ? 'repair' : item.kind === 'learn' ? item.step : item.kind}</span>
      </h2>
      <h3 style={{ margin: '0 0 4px', fontSize: 20 }}>{item.title}</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        {subjects.find((s) => s.subject === item.subject)?.title ?? item.subject} · {item.minutes} min · {item.why}
      </p>
      {seg && <SegmentLine seg={seg} />}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn primary" onClick={() => onOpen(item.concept, item.kind === 'repair' ? item.repair.key : undefined)}>
          <BookOpen size={15} /> Open
        </button>
        {!live && (
          <button className="btn" onClick={() => onStart(item.concept)}>
            <Play size={15} /> Start session
          </button>
        )}
      </div>
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
  if (!id)
    return (
      <a className="btn" href={seg.url} target="_blank" rel="noreferrer">
        <ExternalLink size={14} /> Open {seg.source}
        {seg.pages ? ` (pages ${seg.pages})` : ''}
      </a>
    );
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

function ConceptWork({ concept, repair, live, onStart, onClose }: { concept: string; repair?: string; review?: boolean; live: boolean; onStart: () => void; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [v, setV] = useState<ConceptView | null>(() => (cacheGet<{ items: { view: ConceptView }[] }>('pack')?.items.find((i) => i.view.concept.id === concept)?.view ?? null));
  const [segIndex, setSegIndex] = useState(0);
  const load = useCallback(() => studyCall<ConceptView>('concept', { id: concept }).then(setV).catch((e: Error) => toast(e.message, 'warn')), [concept, toast]);
  useEffect(() => void load(), [load]);
  if (!v) return <div className="empty">Loading…</div>;
  const alt = v.state.missedChecks > 0 && v.path?.alternates.length ? v.path.alternates : null;
  const segs = repair && v.visual ? [v.visual] : (alt ?? v.path?.segments ?? []);
  const seg = segs[Math.min(segIndex, segs.length - 1)];
  const done = async (s: Segment) => {
    const params = { concept, url: s.url, alternate: !!alt, index: segIndex };
    try {
      await studyCall('segment', params);
      toast('Marked as watched', 'success');
      if (segIndex < segs.length - 1) setSegIndex(segIndex + 1);
      void load();
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) {
        enqueue('segment', params);
        toast('Saved — it is sent when the PC is reachable', 'info');
      } else toast((e as Error).message, 'warn');
    }
  };
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{v.concept.title}</h1>
          <p>
            {v.concept.subject} · {RUNG_LABEL[v.state.rung]} · next: {v.state.nextStep}
            {v.hintsOnly ? ' · live graded assignment: hints only' : ''}
          </p>
        </div>
        <div className="row wrap">
          {!live && (
            <button className="btn sm" onClick={onStart}>
              <Play size={14} /> Start session
            </button>
          )}
          <button className="btn ghost sm" onClick={onClose}>
            Back
          </button>
        </div>
      </header>
      <div className="stack lg">
        {repair && <div className="banner" data-tone="drifting"><CircleAlert size={18} /><div className="grow"><h3>Repair</h3><p>Watch the most visual explanation, then answer the retest. It closes when you get it right.</p></div></div>}
        {seg ? (
          <section className="card">
            <h2 className="card-title">
              Watch {segs.length > 1 ? `· ${segIndex + 1} of ${segs.length}` : ''} {alt ? <span className="chip">alternate explanation</span> : null}
            </h2>
            <Player seg={seg} onEnded={() => void done(seg)} />
            <div style={{ marginTop: 10 }}>
              <SegmentLine seg={seg} />
            </div>
            <div className="btn-row" style={{ marginTop: 10 }}>
              <button className="btn sm" onClick={() => void done(seg)}>
                <CheckIcon size={14} /> I watched it
              </button>
            </div>
          </section>
        ) : (
          <div className="empty">No resource yet — tonight's curation adds one.</div>
        )}
        {(v.concept.definition || v.concept.formulas.length > 0 || v.concept.notation.length > 0) && (
          <section className="card">
            <h2 className="card-title">Card</h2>
            {v.concept.definition && <p style={{ marginTop: 0 }}>{v.concept.definition}</p>}
            {v.concept.formulas.map((f) => (
              <p key={f.id} className="mono" style={{ margin: '4px 0' }}>
                {f.name ? `${f.name}: ` : ''}
                {f.latex}
              </p>
            ))}
            {v.concept.notation.length > 0 && <p className="faint">Notation: {v.concept.notation.map((n) => `IITJ ${n.iitj} = ${n.resource}${n.meaning ? ` (${n.meaning})` : ''}`).join(' · ')}</p>}
          </section>
        )}
        {v.pack && !repair && <Explain concept={concept} keyPoints={v.pack.keyPoints} onDone={() => void load()} />}
        {v.pack && <QuickCheck concept={concept} pack={v.pack} repair={repair} onDone={() => void load()} />}
        {v.lab && !repair && <LabBox concept={concept} lab={v.lab} onDone={() => void load()} />}
        <section className="card">
          <h2 className="card-title">Mastery (from evidence)</h2>
          <div className="stack">
            {Object.entries(v.state.mastery).map(([k, val]) => (
              <div key={k} className="row mastery-row" style={{ fontSize: 13 }}>
                <span style={{ width: 110 }}>{k}</span>
                <span className="grow">{val === null ? <span className="faint">no evidence yet</span> : <Bar value={val} color="var(--accent)" />}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Explain({ concept, keyPoints, onDone }: { concept: string; keyPoints: number; onDone: () => void }) {
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
      setRes(await studyCall('tutorExplain', { concept, text }));
      onDone();
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) {
        enqueue('tutorExplain', { concept, text });
        toast('Saved — the tutor checks it when the PC is reachable', 'info');
      } else toast((e as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2 className="card-title">Explain it in your own words</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        The Quick Tutor checks your explanation against {keyPoints} key points Claude wrote in advance.
      </p>
      <textarea className="textarea" rows={5} value={session ? appendSpoken(text, heard) : text} readOnly={!!session} onChange={(e) => setText(e.target.value)} placeholder={mode === 'none' ? 'Type your explanation…' : 'Type or speak your explanation…'} />
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn primary sm" disabled={busy || !!session || text.trim().length < 20} onClick={() => void check()}>
          Check my explanation
        </button>
        {mode !== 'none' &&
          (session ? (
            <button className="btn sm primary" onClick={() => session.stop()}>
              <Mic size={14} /> Listening… tap to stop
            </button>
          ) : (
            <button className="btn sm" onClick={speak}>
              <Mic size={14} /> Speak
            </button>
          ))}
      </div>
      {res && (
        <div className="banner" data-tone={res.pass ? 'info' : 'drifting'} style={{ marginTop: 12 }}>
          {res.pass ? <CheckIcon size={18} /> : <CircleAlert size={18} />}
          <div className="grow">
            <h3>
              {res.pass ? 'Understood' : 'Not yet'} · {pct(res.coverage)} of the key points{res.confidence === 'low' ? ' (Claude re-checks tonight)' : ''}
            </h3>
            <p>{res.feedback}</p>
            {res.missed.length > 0 && <p>Missing: {res.missed.map((m) => m.text).join('; ')}</p>}
            {res.hint && <p>Hint: {res.hint} — try the alternate explanation above.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function QuickCheck({ concept, pack, repair, onDone }: { concept: string; pack: NonNullable<ConceptView['pack']>; repair?: string; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, { correct: boolean; feedback: string }>>({});
  const send = async (qid: string) => {
    const params = { concept, question: qid, answer: answers[qid] ?? '', ...(repair ? { repair } : {}) };
    try {
      const r = await studyCall<{ correct: boolean; feedback: string }>('tutorAnswer', params);
      setResults((x) => ({ ...x, [qid]: r }));
      onDone();
    } catch (e) {
      if (e instanceof StudyApiError && e.status === 0) {
        enqueue('tutorAnswer', params);
        setResults((x) => ({ ...x, [qid]: { correct: false, feedback: 'Saved offline — checked when the PC is reachable.' } }));
      } else toast((e as Error).message, 'warn');
    }
  };
  return (
    <section className="card">
      <h2 className="card-title">{repair ? 'Retest' : 'Quick check'}</h2>
      <div className="stack">
        {pack.questions.map((q) => (
          <div key={q.id}>
            <p style={{ margin: '0 0 6px' }}>{q.q}</p>
            <div className="row">
              {q.options ? (
                <select className="select grow" value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}>
                  <option value="">Choose…</option>
                  {q.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input className="input grow" value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && void send(q.id)} />
              )}
              <button className="btn sm" disabled={!answers[q.id]?.trim()} onClick={() => void send(q.id)}>
                Check
              </button>
            </div>
            {results[q.id] && (
              <p style={{ margin: '4px 0 0', fontSize: 13, color: results[q.id].correct ? 'var(--ok)' : 'var(--warn)' }}>
                {results[q.id].correct ? '✓ ' : ''}
                {results[q.id].feedback}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function LabBox({ concept, lab, onDone }: { concept: string; lab: NonNullable<ConceptView['lab']>; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  const [code, setCode] = useState(lab.starter);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; passed: number; total: number; tests: { name: string; ok: boolean; error?: string }[]; error?: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setRes(await studyCall('labRun', { lab: lab.id, code }));
      onDone();
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
    <div className="row between wrap">
      <span>
        <strong>Review · {title}</strong> <span className="faint">{why}</span>
      </span>
      {!shown ? (
        <button className="btn sm" onClick={() => setShown(true)}>
          Recall it, then grade
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

function IitjTrack({ iitj, onDone }: { iitj: NonNullable<Overview['iitj']>; onDone: () => void }) {
  const toast = useStore((s) => s.toast);
  return (
    <section className="card">
      <h2 className="card-title">
        IITJ track <span>{pct(iitj.track)}</span>
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Lectures {iitj.lecturesWatched}/{iitj.lectures} · assignments {iitj.assignmentsSubmitted}/{iitj.assignments}
      </p>
      <div className="stack">
        {iitj.deadlines.map((d) => (
          <div key={d.id} className="row between">
            <span>
              {d.due} · {d.title} <span className="faint">({d.subject}{d.graded ? ', graded — hints only' : ''})</span>
            </span>
            <button className="btn ghost sm" onClick={() => void studyCall('deadlineSubmit', { id: d.id }).then(onDone, (e: Error) => toast(e.message, 'warn'))}>
              Submitted
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function TestTaking({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [paper, setPaper] = useState<{ title: string; durationMin: number; items: { id: string; subject: string; kind: string; q: string; marks: number; style?: string; entry?: string; starter?: string }[] } | null>(null);
  const [answers, setAnswers] = useState<Record<string, { text?: string; code?: string; image?: string }>>({});
  const [startedAt] = useState(Date.now());
  const [result, setResult] = useState<{ message: string; programming: { id: string; passed: number; total: number; marks: number; of: number }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    studyCall<{ paper: NonNullable<typeof paper> }>('testStart', { id })
      .then((r) => {
        setPaper(r.paper);
        setAnswers(Object.fromEntries(r.paper.items.filter((i) => i.kind === 'programming').map((i) => [i.id, { code: i.starter ?? '' }])));
      })
      .catch((e: Error) => toast(e.message, 'warn'));
  }, [id, toast]);
  const left = paper ? Math.max(0, paper.durationMin * 60_000 - (Date.now() - startedAt)) : 0;
  const photo = (itemId: string, file: File) => {
    const r = new FileReader();
    r.onload = () => setAnswers((a) => ({ ...a, [itemId]: { ...a[itemId], image: String(r.result) } }));
    r.readAsDataURL(file);
  };
  const submit = async () => {
    setBusy(true);
    try {
      setResult(await studyCall('testSubmit', { id, answers }));
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };
  if (!paper) return <div className="empty">Starting the test…</div>;
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{paper.title}</h1>
          <p>
            {paper.durationMin} min · Focus Guard is on · about {Math.round(left / 60_000)} min left
          </p>
        </div>
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

function Extras({ lastTest, onReport, onReload }: { lastTest: Overview['lastTest']; onReport: (id: string) => void; onReload: () => void }) {
  const toast = useStore((s) => s.toast);
  const [props, setProps] = useState<{ id: string; title: string; client: string | null; payload: { rationale?: string } }[]>([]);
  const [changes, setChanges] = useState<{ seq: number; at: number; actor: string; action: string; undone: boolean }[]>([]);
  const [note, setNote] = useState('');
  const [graph, setGraph] = useState<{ id: string; title: string; subject: string; rung: Rung }[] | null>(null);
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
  const bySubject = useMemo(() => {
    const m = new Map<string, NonNullable<typeof graph>>();
    for (const c of graph ?? []) (m.get(c.subject) ?? m.set(c.subject, []).get(c.subject)!).push(c);
    return [...m];
  }, [graph]);
  return (
    <>
      {props.length > 0 && (
        <section className="card">
          <h2 className="card-title">Proposed changes</h2>
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
      <section className="card">
        <h2 className="card-title">More</h2>
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
          <Field label="Capture to the study inbox" hint="A question, a doubt or a link — the next ingest files it.">
            <div className="row">
              <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Why is det(A − λI) = 0?" />
              <button className="btn sm" disabled={!note.trim()} onClick={() => (act('capture', { text: note }, 'Captured'), setNote(''))}>
                <Inbox size={14} /> Save
              </button>
            </div>
          </Field>
          <div className="row between">
            <span>Concept graph</span>
            <button className="btn ghost sm" onClick={() => (graph ? setGraph(null) : void studyCall<{ concepts: NonNullable<typeof graph> }>('concepts').then((r) => setGraph(r.concepts)))}>
              <GraduationCap size={14} /> {graph ? 'Hide' : 'Show'}
            </button>
          </div>
          {graph &&
            bySubject.map(([s, cs]) => (
              <div key={s}>
                <strong style={{ fontSize: 13 }}>{s}</strong>
                <div className="row wrap" style={{ marginTop: 4 }}>
                  {cs.map((c) => (
                    <span key={c.id} className="chip" title={RUNG_LABEL[c.rung]} style={{ opacity: c.rung === 'none' ? 0.55 : 1 }}>
                      {c.title} · {RUNG_LABEL[c.rung]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
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
      </section>
    </>
  );
}
