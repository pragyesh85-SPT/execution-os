import { AnimatePresence, motion } from 'motion/react';
import { ClipboardCopy, ClipboardPaste, Clapperboard, Plus, RotateCcw, Sparkles, Trash, WandSparkles, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { liveBlocks, missionFor, planFor } from '../core/engine';
import { fullPlannerPrompt, parsePlannerReply, PLANNER_SYSTEM, plannableBlocks, plannerContext, plannerUserPrompt, smartFill, taskValue, toMission, toOutcomes, type PlannerResult } from '../core/planner';
import { entertainmentBalance } from '../core/stats';
import type { Area, Mission, Outcome, PlanBlock, Task } from '../core/types';
import { addDays, clockOf, fmtClock, fmtDur, longDate, offsetFromClock, parseClock, parseKey, weekKey } from '../core/time';
import { CatChip, Check, EASE, Field, Segmented, Sheet, catColor } from '../components/ui';
import { addException, addTask, deleteTask, removeException, resetDayToTemplate, setMission, setOutcomes, setPlanMeta, today, uid, updateTask } from '../state/actions';
import { useStore } from '../state/store';
import { aiComplete } from '../lib/ai';
import { useNow } from '../state/runtime';

export function Plan() {
  const doc = useStore((s) => s.doc);
  const now = Math.floor(useNow() / 60_000) * 60_000;
  const [which, setWhich] = useState<'today' | 'tomorrow'>('today');
  const base = today();
  const date = which === 'today' ? base : addDays(base, 1);
  const plan = planFor(doc, date);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Plan</h1>
          <p>
            {longDate(date)} · the clock decides <em>when</em>, this page decides <em>what</em>.
          </p>
        </div>
        <Segmented
          id="plan-day"
          value={which}
          onChange={setWhich}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'tomorrow', label: 'Tomorrow' },
          ]}
        />
      </header>
      <div className="plan-grid">
        <div className="stack lg">
          <PlannerCard date={date} />
          <OutcomesEditor key={`o-${date}`} date={date} outcomes={plan.outcomes} />
          <section className="card">
            <h2 className="card-title">
              <span>Missions per block</span>
              <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
                one clear outcome each
              </span>
            </h2>
            <div className="stack">
              {plannableBlocks(doc, date, now)
                .map((b) => (
                  <MissionEditor key={`${date}-${b.id}`} date={date} block={b} mission={missionFor(plan, b)} />
                ))}
              {plannableBlocks(doc, date, now).length === 0 && <p className="muted">No focus blocks left on this day.</p>}
            </div>
          </section>
          <ExceptionsCard date={date} />
        </div>
        <TaskInbox date={date} />
      </div>
    </div>
  );
}

// ---------------- planner ----------------

function PlannerCard({ date }: { date: string }) {
  const doc = useStore((s) => s.doc);
  const local = useStore((s) => s.local);
  const toast = useStore((s) => s.toast);
  const setTab = useStore((s) => s.setTab);
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<{ result: PlannerResult; source: Mission['source'] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = planFor(doc, date);
  const ctx = useMemo(() => plannerContext(doc, date), [doc, date]);
  const validIds = ctx.blocks.map((b) => b.id);
  const apiReady = local.aiMode === 'api' && (local.ai.apiKey || local.ai.provider === 'compatible');

  const apply = (result: PlannerResult, source: Mission['source']) => {
    if (result.outcomes.length) setOutcomes(date, toOutcomes(result.outcomes, () => uid('o')));
    for (const m of result.missions) setMission(date, m.blockId, toMission(m, source, () => uid('st')));
    setPlanMeta(date, { plannedBy: source === 'ai' ? 'ai' : source === 'import' ? 'import' : 'manual' });
    toast(`Plan applied: ${result.outcomes.length} outcomes, ${result.missions.length} missions.`, 'success');
    setPreview(null);
  };

  const runAi = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = await aiComplete(local.ai, PLANNER_SYSTEM, plannerUserPrompt(ctx), { json: true });
      setPreview({ result: parsePlannerReply(text, validIds), source: 'ai' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyPrompt = async () => {
    const text = fullPlannerPrompt(ctx);
    try {
      await navigator.clipboard.writeText(text);
      toast('Prompt copied. Paste it into ChatGPT / Claude, then paste the reply back here.', 'success');
    } catch {
      setPromptOpen(true);
    }
  };

  return (
    <section className="card">
      <h2 className="card-title">
        <span>Planner</span>
        <span className="chip">{plan.plannedBy ? `planned · ${plan.plannedBy}` : 'not planned yet'}</span>
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Picks the highest-value mission for each focus block and the day's 3 outcomes from your task inbox
        {ctx.tasks.length ? ` (${ctx.tasks.length} open tasks)` : ''}. Rules decide the time slots — the planner never moves them.
      </p>
      <div className="btn-row">
        {apiReady ? (
          <button className="btn primary" disabled={busy} onClick={runAi}>
            <Sparkles size={16} /> {busy ? 'Thinking…' : 'Generate with AI'}
          </button>
        ) : (
          <button className="btn" onClick={() => setTab('settings')}>
            <Sparkles size={16} /> Connect an AI key
          </button>
        )}
        <button className="btn" onClick={() => setPreview({ result: smartFill(doc, date), source: 'manual' })}>
          <WandSparkles size={16} /> Smart fill from tasks
        </button>
        <button className="btn ghost" onClick={copyPrompt}>
          <ClipboardCopy size={16} /> Copy prompt
        </button>
        <button className="btn ghost" onClick={() => setPasteOpen(true)}>
          <ClipboardPaste size={16} /> Paste AI reply
        </button>
      </div>
      <AnimatePresence>
        {error && (
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ color: 'var(--bad)', fontSize: 14, marginBottom: 0 }}>
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <Sheet
        open={!!preview}
        onClose={() => setPreview(null)}
        title="Review the proposed plan"
        subtitle={preview?.source === 'ai' ? 'Generated by AI from your tasks' : preview?.source === 'import' ? 'Imported from a pasted reply' : 'Built-in smart fill (no AI)'}
        footer={
          <>
            <button className="btn ghost" onClick={() => setPreview(null)}>
              Discard
            </button>
            <button className="btn primary" disabled={!preview || (!preview.result.outcomes.length && !preview.result.missions.length)} onClick={() => preview && apply(preview.result, preview.source)}>
              Apply to {date === today() ? 'today' : 'tomorrow'}
            </button>
          </>
        }
      >
        {preview && (
          <div className="stack lg">
            {!preview.result.outcomes.length && !preview.result.missions.length && (
              <div className="empty">
                <strong>Nothing to propose.</strong>
                <span>Add a few tasks to the inbox (with area and deadline) and try again.</span>
              </div>
            )}
            {preview.result.outcomes.length > 0 && (
              <div>
                <h3 className="card-title">Outcomes</h3>
                <ol style={{ margin: 0, paddingLeft: 20 }}>
                  {preview.result.outcomes.map((o, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>
                      {o.text} <span className="chip">{o.area}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {preview.result.missions.length > 0 && (
              <div className="stack">
                <h3 className="card-title" style={{ margin: 0 }}>
                  Missions
                </h3>
                {preview.result.missions.map((m) => {
                  const b = ctx.blocks.find((x) => x.id === m.blockId);
                  return (
                    <div key={m.blockId} className="mission-block">
                      <div className="mission-head">
                        <strong>{b?.title}</strong>
                        <span className="mono faint">
                          {b?.start}–{b?.end}
                        </span>
                      </div>
                      <div style={{ fontWeight: 500 }}>{m.title}</div>
                      {m.steps.length > 0 && (
                        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--ink-2)', fontSize: 14 }}>
                          {m.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ul>
                      )}
                      {m.estimate ? <span className="faint mono" style={{ fontSize: 12 }}>est. {fmtDur(m.estimate)}</span> : null}
                    </div>
                  );
                })}
              </div>
            )}
            {preview.result.note && <p className="muted">{preview.result.note}</p>}
          </div>
        )}
      </Sheet>

      <Sheet
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title="Paste the AI reply"
        subtitle="Works with any chat AI. Paste the whole answer — the JSON is found automatically."
        footer={
          <>
            <button className="btn ghost" onClick={() => setPasteOpen(false)}>
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={!paste.trim()}
              onClick={() => {
                try {
                  const result = parsePlannerReply(paste, validIds);
                  setPasteOpen(false);
                  setPaste('');
                  setPreview({ result, source: 'import' });
                } catch (err) {
                  toast(`Could not read that reply: ${(err as Error).message}`, 'warn');
                }
              }}
            >
              Read reply
            </button>
          </>
        }
      >
        <textarea className="textarea mono" style={{ minHeight: 220, fontSize: 13 }} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder='{"outcomes":[…],"missions":[…]}' />
      </Sheet>

      <Sheet open={promptOpen} onClose={() => setPromptOpen(false)} title="Planner prompt" subtitle="Select all and copy it into your AI chat.">
        <div className="prompt-box">{fullPlannerPrompt(ctx)}</div>
      </Sheet>
    </section>
  );
}

// ---------------- outcomes ----------------

function OutcomesEditor({ date, outcomes }: { date: string; outcomes: Outcome[] }) {
  const [rows, setRows] = useState<Outcome[]>(() => {
    const r = [...outcomes];
    while (r.length < 3) r.push({ id: uid('o'), text: '', area: r.length === 0 ? 'iit' : 'founder', done: false });
    return r;
  });
  const sig = JSON.stringify(outcomes);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editing) return;
    const r = [...outcomes];
    while (r.length < 3) r.push({ id: uid('o'), text: '', area: r.length === 0 ? 'iit' : 'founder', done: false });
    setRows(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const save = (next: Outcome[]) => {
    setRows(next);
    setOutcomes(
      date,
      next.filter((o) => o.text.trim()),
    );
  };
  return (
    <section className="card">
      <h2 className="card-title">
        <span>3 daily outcomes</span>
        <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
          everything else is secondary
        </span>
      </h2>
      <div className="stack">
        {rows.map((o, i) => (
          <div key={o.id} className="row">
            <span className="mono faint" style={{ width: 14 }}>
              {i + 1}
            </span>
            <input
              className="input grow"
              value={o.text}
              placeholder={i === 0 ? 'IIT: Submit Week 6 statistics assignment' : i === 1 ? 'Founder: Finish onboarding UI' : 'Founder: Finalize payment workflow'}
              onChange={(e) => setRows(rows.map((r) => (r.id === o.id ? { ...r, text: e.target.value } : r)))}
              onFocus={() => setEditing(true)}
              onBlur={() => {
                setEditing(false);
                save(rows);
              }}
            />
            <select className="select" style={{ width: 120 }} value={o.area} onChange={(e) => save(rows.map((r) => (r.id === o.id ? { ...r, area: e.target.value as Area } : r)))}>
              <option value="iit">IIT</option>
              <option value="founder">Founder</option>
              <option value="personal">Personal</option>
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------- missions ----------------

function MissionEditor({ date, block, mission }: { date: string; block: PlanBlock; mission: Mission | undefined }) {
  const doc = useStore((s) => s.doc);
  const ds = doc.settings.dayStart;
  const key = mission && (planFor(doc, date).missions[block.id] ? block.id : block.origin ?? block.id);
  const target = key ?? block.id;
  const [title, setTitle] = useState(mission?.title ?? '');
  const [steps, setSteps] = useState(mission?.steps ?? []);
  const [stepText, setStepText] = useState('');
  const [editing, setEditing] = useState(false);
  const sig = JSON.stringify(mission ?? null);
  useEffect(() => {
    if (editing) return;
    setTitle(mission?.title ?? '');
    setSteps(mission?.steps ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  const area: Area = block.category === 'iit' ? 'iit' : block.category === 'founder' ? 'founder' : 'personal';
  const candidates = Object.values(doc.tasks)
    .filter((t) => !t.del && !t.done && t.area === area)
    .sort((a, b) => taskValue(b, date) - taskValue(a, date))
    .slice(0, 12);

  const commit = (nextTitle = title, nextSteps = steps) => {
    if (!nextTitle.trim() && !nextSteps.length) {
      if (mission) setMission(date, target, null);
      return;
    }
    setMission(date, target, { ...(mission ?? {}), title: nextTitle.trim(), steps: nextSteps, source: mission?.source ?? 'manual' });
  };

  return (
    <div className="mission-block" style={{ ['--c' as string]: catColor(block.category) }}>
      <div className="mission-head">
        <div className="row">
          <CatChip category={block.category} />
          <strong>{block.title}</strong>
        </div>
        <span className="mono faint">
          {fmtClock(clockOf(block.s, ds))}–{fmtClock(clockOf(block.e, ds))} · {fmtDur(block.e - block.s)}
        </span>
      </div>
      <div className="row">
        <input className="input grow" value={title} placeholder="The one outcome for this block, e.g. Finish Assignment 3, Q1–Q5" onChange={(e) => setTitle(e.target.value)} onFocus={() => setEditing(true)} onBlur={() => {
            setEditing(false);
            commit();
          }} />
        {candidates.length > 0 && (
          <select
            className="select"
            style={{ width: 150 }}
            value=""
            onChange={(e) => {
              const t = candidates.find((c) => c.id === e.target.value);
              if (t) {
                setTitle(t.title);
                commit(t.title, steps);
              }
            }}
            aria-label="Pick from tasks"
          >
            <option value="">From tasks…</option>
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <AnimatePresence initial={false}>
        {steps.map((s) => (
          <motion.div key={s.id} className="step-row" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: EASE }}>
            <Check
              on={s.done}
              onChange={() => {
                const next = steps.map((x) => (x.id === s.id ? { ...x, done: !x.done } : x));
                setSteps(next);
                commit(title, next);
              }}
              label={s.text}
            />
            <span className="grow" style={{ fontSize: 14 }}>
              {s.text}
            </span>
            <button
              className="btn ghost icon sm"
              aria-label="Remove step"
              onClick={() => {
                const next = steps.filter((x) => x.id !== s.id);
                setSteps(next);
                commit(title, next);
              }}
            >
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!stepText.trim()) return;
          const next = [...steps, { id: uid('st'), text: stepText.trim(), done: false }];
          setSteps(next);
          setStepText('');
          commit(title, next);
        }}
      >
        <input className="input grow" value={stepText} placeholder="Add a step (press Enter)" onChange={(e) => setStepText(e.target.value)} />
        <button className="btn sm" type="submit" disabled={!stepText.trim()}>
          <Plus size={14} /> Step
        </button>
      </form>
    </div>
  );
}

// ---------------- planned exceptions ----------------

function ExceptionsCard({ date }: { date: string }) {
  const doc = useStore((s) => s.doc);
  const now = useNow();
  const ds = doc.settings.dayStart;
  const plan = planFor(doc, date);
  const [start, setStart] = useState('15:00');
  const [dur, setDur] = useState(120);
  const [title, setTitle] = useState('Movie');
  const toast = useStore((s) => s.toast);
  const bal = entertainmentBalance(doc, weekKey(date), now);
  const exceptions = plan.blocks.filter((b) => b.exception);

  const add = () => {
    const clock = parseClock(start);
    if (clock === null) return toast('Use a time like 15:00 or 3:00 pm.', 'warn');
    const s = offsetFromClock(clock, ds);
    const e = Math.min(1440, s + dur);
    const over = plan.blocks.filter((b) => !b.missed && b.fixed && !b.exception && b.s < e && b.e > s);
    if (over.length) return toast(`That overlaps a fixed anchor (${over[0].title}). Pick another time.`, 'warn');
    addException(date, s, e, title.trim() || 'Entertainment');
    toast(`${title} planned. It is now part of the schedule, not procrastination.`, 'success');
  };

  return (
    <section className="card">
      <h2 className="card-title">
        <span>Planned exceptions</span>
        <span className="mono" style={{ textTransform: 'none', letterSpacing: 0, color: bal.remaining < 0 ? 'var(--bad)' : undefined }}>
          {fmtDur(Math.max(0, bal.remaining))} of {fmtDur(bal.budget)} left this week
        </span>
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Entertainment is allowed — it just gets a budget and a slot. Adding one shrinks whatever flexible block it overlaps.
      </p>
      <div className="form-grid">
        <Field label="What">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Starts at">
          <input className="input mono" value={start} onChange={(e) => setStart(e.target.value)} placeholder="15:00" />
        </Field>
        <Field label="Duration">
          <select className="select" value={dur} onChange={(e) => setDur(Number(e.target.value))}>
            {[30, 60, 90, 120, 150, 180].map((m) => (
              <option key={m} value={m}>
                {fmtDur(m)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={add}>
          <Clapperboard size={16} /> Add to {date === today() ? 'today' : 'tomorrow'}
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            resetDayToTemplate(date);
            toast('Day reset to the master clock. Missions and outcomes kept.', 'success');
          }}
        >
          <RotateCcw size={16} /> Reset day to master clock
        </button>
      </div>
      {exceptions.length > 0 && (
        <div className="stack" style={{ marginTop: 16 }}>
          {exceptions.map((x) => (
            <div key={x.id} className="row between" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <span className="row">
                <span className="dot" style={{ background: catColor(x.category) }} />
                {x.title}
                <span className="mono faint">
                  {fmtClock(clockOf(x.s, ds))}–{fmtClock(clockOf(x.e, ds))}
                </span>
              </span>
              <button className="btn ghost sm danger" onClick={() => removeException(date, x.id)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------- task inbox ----------------

function TaskInbox({ date }: { date: string }) {
  const doc = useStore((s) => s.doc);
  const [filter, setFilter] = useState<'all' | Area>('all');
  const [title, setTitle] = useState('');
  const [area, setArea] = useState<Area>('iit');
  const [deadline, setDeadline] = useState('');
  const [estimate, setEstimate] = useState('');
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [showDone, setShowDone] = useState(false);

  const tasks = Object.values(doc.tasks)
    .filter((t) => !t.del && (filter === 'all' || t.area === filter) && (showDone || !t.done))
    .sort((a, b) => Number(a.done) - Number(b.done) || taskValue(b, date) - taskValue(a, date));

  useEffect(() => {
    if (filter !== 'all') setArea(filter);
  }, [filter]);

  return (
    <section className="card" style={{ position: 'sticky', top: 24 }}>
      <h2 className="card-title">
        <span>Task inbox</span>
        <span className="mono">{Object.values(doc.tasks).filter((t) => !t.del && !t.done).length} open</span>
      </h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          addTask({
            title: title.trim(),
            area,
            deadline: deadline || undefined,
            estimate: estimate ? Number(estimate) : undefined,
            priority,
          });
          setTitle('');
          setEstimate('');
        }}
      >
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Probability Assignment 4 · Fix onboarding UX" />
        <div className="row wrap">
          <Segmented
            id="task-area"
            value={area}
            onChange={setArea}
            options={[
              { value: 'iit', label: 'IIT' },
              { value: 'founder', label: 'Founder' },
              { value: 'personal', label: 'Personal' },
            ]}
          />
        </div>
        <div className="form-grid">
          <Field label="Deadline">
            <input className="input mono" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          <Field label="Estimate (min)">
            <input className="input mono" inputMode="numeric" value={estimate} onChange={(e) => setEstimate(e.target.value.replace(/\D/g, ''))} placeholder="85" />
          </Field>
          <Field label="Priority">
            <select className="select" value={priority} onChange={(e) => setPriority(Number(e.target.value) as 1 | 2 | 3)}>
              <option value={1}>High</option>
              <option value={2}>Normal</option>
              <option value={3}>Low</option>
            </select>
          </Field>
        </div>
        <button className="btn ink" type="submit" disabled={!title.trim()}>
          <Plus size={16} /> Add task
        </button>
      </form>
      <div className="divider" />
      <div className="row between wrap" style={{ marginBottom: 8 }}>
        <Segmented
          id="task-filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'iit', label: 'IIT' },
            { value: 'founder', label: 'Founder' },
            { value: 'personal', label: 'Personal' },
          ]}
        />
        <button className="btn ghost sm" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hide done' : 'Show done'}
        </button>
      </div>
      {tasks.length === 0 ? (
        <div className="empty">
          <strong>Inbox is empty.</strong>
          <span>Add assignments, lectures, features, meetings. The planner turns them into missions.</span>
        </div>
      ) : (
        <motion.div layout>
          <AnimatePresence initial={false}>
            {tasks.map((t) => (
              <TaskRow key={t.id} task={t} date={date} />
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </section>
  );
}

function TaskRow({ task, date }: { task: Task; date: string }) {
  const dl = task.deadline ? Math.round((parseKey(task.deadline).getTime() - parseKey(date).getTime()) / 86_400_000) : null;
  const due = dl === null ? null : dl < 0 ? `overdue ${-dl}d` : dl === 0 ? 'due today' : dl === 1 ? 'due tomorrow' : `due in ${dl}d`;
  return (
    <motion.div
      layout
      className="task"
      data-done={task.done}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
      transition={{ duration: 0.22, ease: EASE }}
    >
      <Check on={task.done} onChange={() => updateTask(task.id, { done: !task.done })} label={task.title} />
      <div style={{ minWidth: 0 }}>
        <div className="ttl">{task.title}</div>
        <div className="meta">
          <span className="chip">
            <span className="dot" style={{ background: catColor(task.area === 'personal' ? 'care' : task.area) }} />
            {task.area === 'iit' ? 'IIT' : task.area === 'founder' ? 'Founder' : 'Personal'}
          </span>
          {due && (
            <span className="chip" style={{ color: dl !== null && dl <= 1 ? 'var(--bad)' : undefined }}>
              {due}
            </span>
          )}
          {task.estimate ? <span className="chip mono">{fmtDur(task.estimate)}</span> : null}
          {task.priority === 1 && <span className="chip">high</span>}
          {task.carried && <span className="chip">carried by rescue</span>}
        </div>
      </div>
      <button className="btn ghost icon sm" aria-label={`Delete ${task.title}`} onClick={() => deleteTask(task.id)}>
        <Trash size={14} />
      </button>
    </motion.div>
  );
}

