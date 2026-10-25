import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, CircleDot, Pin, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { adherence, liveBlocks, planFor, proofFor } from '../core/engine';
import { childLevel, childrenOf, goalProgress, goalsFor, goalWarnings, periodOf, periodRange, suggestBreakdown, type GoalProgress } from '../core/goals';
import type { Area, Category, Doc, Goal, GoalLevel, GoalMetric, PlanBlock } from '../core/types';
import { addDays, clockOf, fmtClock, fmtDur, longDate, MONTHS, offsetOf, parseKey, shortDate, weekDays, weekKey } from '../core/time';
import { BlockRow } from '../components/BlockRow';
import { EASE, Field, Segmented, Sheet, catColor } from '../components/ui';
import { attempt, checkinGoal, setGoalStatus, today, toggleMilestone, upsertGoal } from '../state/actions';
import { useFlag } from '../state/hooks';
import { useNow } from '../state/runtime';
import { useStore } from '../state/store';

// Calendar + Progress: targets (year → month → week) with an honest pace, and read-only
// Day / Week / Month views of the blocks. Tapping a block opens the block sheet.

const PACE_COLOR: Record<GoalProgress['pace'], string> = { done: 'var(--ok)', ahead: 'var(--ok)', on_track: 'var(--ok)', behind: 'var(--warn)', at_risk: 'var(--bad)' };
const PACE_LABEL: Record<GoalProgress['pace'], string> = { done: 'done', ahead: 'ahead', on_track: 'on track', behind: 'behind', at_risk: 'at risk' };

const unitOf = (m: GoalMetric) => (m.kind === 'hours' ? 'h' : m.kind === 'count' ? ` ${m.unit}` : m.kind === 'milestones' ? ' milestones' : '');
const fmtNum = (n: number) => (Math.round(n * 10) / 10).toString();

export function periodLabel(level: GoalLevel, period: string) {
  if (level === 'year') return period;
  if (level === 'month') return `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
  if (level === 'week') return `${shortDate(period)} – ${shortDate(addDays(period, 6))}`;
  return longDate(period);
}

/** Status glyph of a block on a date: ✓ done, ◐ partial, ✕ missed, or nothing (upcoming / not tracked). */
export function blockGlyph(doc: Doc, date: string, b: PlanBlock, nowMs: number): '✓' | '◐' | '✕' | '' {
  const p = proofFor(doc, date, b.id);
  if (p?.status === 'done') return '✓';
  if (p?.status === 'partial') return '◐';
  if (p?.status === 'none') return '✕';
  if (b.focus && !b.missed && b.e <= offsetOf(nowMs, date, doc.settings.dayStart)) return '✕';
  return '';
}

export function Calendar() {
  const doc = useStore((s) => s.doc);
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const goalsOn = useFlag('goals');
  const [view, setView] = useState<'day' | 'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(today());
  const [sheet, setSheet] = useState<GoalSheetState | null>(null);
  const step = (n: number) => setAnchor(view === 'day' ? addDays(anchor, n) : view === 'week' ? addDays(anchor, 7 * n) : shiftMonth(anchor, n));
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Calendar</h1>
          <p>Targets and the plan against what actually happened.</p>
        </div>
      </header>
      <div className="stack lg">
        {goalsOn && <TargetsPanel onOpen={setSheet} />}
        <section className="card">
          <div className="row between wrap" style={{ marginBottom: 12, gap: 8 }}>
            <Segmented
              id="cal-view"
              value={view}
              onChange={setView}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ]}
            />
            <div className="row" style={{ gap: 6 }}>
              <button className="btn icon sm" aria-label="Previous" onClick={() => step(-1)}>
                <ChevronLeft size={16} />
              </button>
              <span className="mono" style={{ minWidth: 150, textAlign: 'center', fontSize: 13 }}>
                {view === 'day' ? longDate(anchor) : view === 'week' ? periodLabel('week', weekKey(anchor)) : periodLabel('month', anchor.slice(0, 7))}
              </span>
              <button className="btn icon sm" aria-label="Next" onClick={() => step(1)}>
                <ChevronRight size={16} />
              </button>
              <button className="btn ghost sm" onClick={() => setAnchor(today())}>
                Today
              </button>
            </div>
          </div>
          {view === 'day' && <DayView date={anchor} minute={minute} />}
          {view === 'week' && <WeekView weekStart={weekKey(anchor)} minute={minute} />}
          {view === 'month' && (
            <MonthView
              month={anchor.slice(0, 7)}
              minute={minute}
              onPick={(d) => {
                setAnchor(d);
                setView('day');
              }}
            />
          )}
          <div className="legend" style={{ marginTop: 12 }}>
            <span>✓ done</span>
            <span>◐ partial</span>
            <span>✕ missed</span>
            <span>
              <Pin size={11} /> pinned
            </span>
            <span>
              <CircleDot size={11} /> rescued
            </span>
          </div>
        </section>
      </div>
      {sheet?.goalId && <GoalDetail id={sheet.goalId} onClose={() => setSheet(null)} onCreateChild={(c) => setSheet({ create: c })} />}
      {sheet?.create && <GoalForm init={sheet.create} onClose={() => setSheet(null)} />}
    </div>
  );
}

function shiftMonth(date: string, n: number) {
  const d = parseKey(date);
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ---------------- targets ----------------

interface GoalSheetState {
  goalId?: string;
  create?: { level: GoalLevel; period: string; parentId?: string };
}

function TargetsPanel({ onOpen }: { onOpen: (s: GoalSheetState) => void }) {
  const doc = useStore((s) => s.doc);
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const [level, setLevel] = useState<'week' | 'month' | 'year'>('week');
  const date = today();
  const period = periodOf(level, date);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => goalsFor(doc, level, period).map((g) => ({ g, p: goalProgress(doc, g, now) })), [doc, level, period, minute]);
  const warnings = useMemo(() => goalWarnings(doc, date), [doc, date]);
  return (
    <section className="card">
      <div className="row between wrap" style={{ marginBottom: 10, gap: 8 }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          Targets · {periodLabel(level, period)}
        </h2>
        <Segmented
          id="target-level"
          value={level}
          onChange={setLevel}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'month', label: 'Month' },
            { value: 'year', label: 'Year' },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <strong>No {level} targets yet.</strong>
          <span>Measurable only: hours, a count, done/not done, or milestones. Claude can create the whole tree from “here’s my plan for October”.</span>
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {rows.map(({ g, p }) => (
            <button key={g.id} className="target-row" onClick={() => onOpen({ goalId: g.id })}>
              <div className="row between" style={{ gap: 8 }}>
                <span className="t">{g.title}</span>
                <span className="mono faint" style={{ fontSize: 12 }}>
                  {fmtNum(p.actual)}/{fmtNum(p.target)}
                  {unitOf(g.metric)} · <span style={{ color: PACE_COLOR[p.pace] }}>{PACE_LABEL[p.pace]}</span>
                </span>
              </div>
              <BulletBar p={p} />
            </button>
          ))}
        </div>
      )}
      {warnings.map((w) => (
        <p key={w} style={{ color: 'var(--warn)', fontSize: 13, margin: '8px 0 0' }}>
          {w}
        </p>
      ))}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => onOpen({ create: { level, period } })}>
          <Plus size={14} /> Add {level} target
        </button>
      </div>
    </section>
  );
}

export function BulletBar({ p }: { p: GoalProgress }) {
  return (
    <div className="bullet" aria-label={`${Math.round(Math.min(1, p.pct) * 100)}% done, expected ${Math.round(p.expectedPct * 100)}%`}>
      <motion.i style={{ background: PACE_COLOR[p.pace] }} initial={{ scaleX: 0 }} animate={{ scaleX: Math.min(1, p.pct) }} transition={{ duration: 0.6, ease: EASE }} />
      <b style={{ left: `${Math.min(100, p.expectedPct * 100)}%` }} />
    </div>
  );
}

function GoalDetail({ id, onClose, onCreateChild }: { id: string; onClose: () => void; onCreateChild: (c: { level: GoalLevel; period: string; parentId: string }) => void }) {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const now = useNow();
  const g = doc.goals[id];
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  if (!g || g.del) return null;
  const p = goalProgress(doc, g, now);
  const kids = childrenOf(doc, g);
  const sessions = linkedLogs(doc, g);
  const lvl = childLevel[g.level];
  return (
    <Sheet open onClose={onClose} title={g.title} subtitle={`${g.level} target · ${periodLabel(g.level, g.period)}${g.why ? ` · why: ${g.why}` : ''}`}>
      <div className="stack lg">
        <div className="stack" style={{ gap: 6 }}>
          <div className="row between">
            <strong>
              {fmtNum(p.actual)} / {fmtNum(p.target)}
              {unitOf(g.metric)}
            </strong>
            <span style={{ color: PACE_COLOR[p.pace] }}>
              {Math.round(Math.min(1, p.pct) * 100)}% · expected {Math.round(p.expectedPct * 100)}% · {PACE_LABEL[p.pace]}
            </span>
          </div>
          <BulletBar p={p} />
        </div>

        {g.metric.kind === 'milestones' && (
          <div className="stack" style={{ gap: 6 }}>
            {g.metric.items.map((i) => (
              <label key={i.id} className="row" style={{ fontSize: 14 }}>
                <input type="checkbox" checked={i.done} onChange={() => toggleMilestone(g.id, i.id)} /> {i.text}
              </label>
            ))}
          </div>
        )}

        {(g.metric.kind === 'hours' || g.metric.kind === 'count') && (
          <div className="stack" style={{ gap: 6 }}>
            <strong style={{ fontSize: 14 }}>Check in progress done outside a block</strong>
            <div className="row">
              <input className="input mono" style={{ width: 90 }} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={g.metric.kind === 'hours' ? '1.5' : '1'} />
              <input className="input grow" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" />
              <button
                className="btn"
                onClick={() => {
                  if (attempt(() => checkinGoal(g.id, Number(value), note))) {
                    setValue('');
                    setNote('');
                    toast('Progress added.', 'success');
                  }
                }}
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        )}

        {sessions.length > 0 && (
          <div className="stack" style={{ gap: 4 }}>
            <strong style={{ fontSize: 14 }}>Linked sessions</strong>
            {sessions.slice(0, 8).map((s) => (
              <span key={s.key} className="faint" style={{ fontSize: 13 }}>
                {shortDate(s.date)} · {s.title} · {s.status}
              </span>
            ))}
          </div>
        )}

        {lvl && (
          <div className="stack" style={{ gap: 6 }}>
            <strong style={{ fontSize: 14 }}>{lvl[0].toUpperCase() + lvl.slice(1)} targets under this</strong>
            {kids.length === 0 && <span className="faint" style={{ fontSize: 13 }}>None yet.</span>}
            {kids.map((k) => {
              const kp = goalProgress(doc, k, now);
              return (
                <div key={k.id} className="stack" style={{ gap: 4 }}>
                  <span style={{ fontSize: 13 }}>
                    {k.title} <span className="faint">· {periodLabel(k.level, k.period)} · {PACE_LABEL[kp.pace]}</span>
                  </span>
                  <BulletBar p={kp} />
                </div>
              );
            })}
            <div className="btn-row">
              <button
                className="btn sm"
                onClick={() => {
                  const drafts = suggestBreakdown(doc, g, now);
                  if (!drafts.length) return toast('Nothing to break down (milestones, or every period already has a target).', 'info');
                  if (attempt(() => drafts.forEach((d) => upsertGoal(d)))) toast(`${drafts.length} ${lvl} targets added — an even split of what is left.`, 'success');
                }}
              >
                Break down
              </button>
              <button className="btn ghost sm" onClick={() => onCreateChild({ level: lvl, period: periodOf(lvl, today() > periodRange(g.level, g.period)[0] ? today() : periodRange(g.level, g.period)[0]), parentId: g.id })}>
                <Plus size={14} /> Add one
              </button>
            </div>
          </div>
        )}

        <div className="btn-row">
          {g.status !== 'done' ? (
            <button className="btn" onClick={() => setGoalStatus(g.id, 'done')}>
              Mark done
            </button>
          ) : (
            <button className="btn" onClick={() => setGoalStatus(g.id, 'active')}>
              Reopen
            </button>
          )}
          <button
            className="btn ghost danger"
            onClick={() => {
              setGoalStatus(g.id, 'dropped');
              toast('Target dropped. It no longer counts; nothing was deleted.', 'info');
              onClose();
            }}
          >
            Drop
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function linkedLogs(doc: Doc, g: Goal) {
  const [from, to] = periodRange(g.level, g.period);
  const out: { key: string; date: string; title: string; status: string }[] = [];
  for (const p of Object.values(doc.proofs)) {
    if (p.del || p.date < from || p.date > to) continue;
    const plan = planFor(doc, p.date);
    const b = plan.blocks.find((x) => x.id === p.blockId);
    const m = b ? (plan.missions[b.id] ?? (b.origin ? plan.missions[b.origin] : undefined)) : undefined;
    if (p.goalId === g.id || m?.goalId === g.id) out.push({ key: p.id, date: p.date, title: m?.title ?? b?.title ?? p.blockId, status: p.status });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

const HOUR_CATS: Category[] = ['iit', 'founder', 'devotion', 'care'];

function GoalForm({ init, onClose }: { init: { level: GoalLevel; period: string; parentId?: string }; onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const [title, setTitle] = useState('');
  const [area, setArea] = useState<Area>('iit');
  const [kind, setKind] = useState<GoalMetric['kind']>('hours');
  const [target, setTarget] = useState('10');
  const [unit, setUnit] = useState('modules');
  const [cats, setCats] = useState<Category[]>(['iit']);
  const [items, setItems] = useState('');
  const [why, setWhy] = useState('');
  const parentLevel = ({ day: 'week', week: 'month', month: 'year', year: null } as const)[init.level];
  const parents = parentLevel ? goalsFor(doc, parentLevel, periodOf(parentLevel, periodRange(init.level, init.period)[0])) : [];
  const [parentId, setParentId] = useState(init.parentId ?? '');
  const save = () => {
    const metric: GoalMetric =
      kind === 'hours' ? { kind, categories: cats } : kind === 'count' ? { kind, unit: unit.trim() || 'items' } : kind === 'binary' ? { kind } : { kind, items: items.split('\n').map((t) => t.trim()).filter(Boolean).map((text) => ({ id: '', text, done: false })) };
    const ok = attempt(() => upsertGoal({ level: init.level, period: init.period, title, area, metric, target: Number(target) || 0, ...(parentId ? { parentId } : {}), ...(why.trim() ? { why: why.trim() } : {}) }));
    if (ok) {
      toast('Target added.', 'success');
      onClose();
    }
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`New ${init.level} target`}
      subtitle={periodLabel(init.level, init.period)}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!title.trim()} onClick={save}>
            Add target
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Target">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={init.level === 'week' ? '12 hours of study' : 'Finish 4 modules'} />
        </Field>
        <div className="form-grid">
          <Field label="Area">
            <select className="select" value={area} onChange={(e) => setArea(e.target.value as Area)}>
              <option value="iit">IIT</option>
              <option value="founder">Founder</option>
              <option value="personal">Personal</option>
            </select>
          </Field>
          <Field label="Measured as">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as GoalMetric['kind'])}>
              <option value="hours">Hours</option>
              <option value="count">A count</option>
              <option value="binary">Done / not done</option>
              <option value="milestones">Milestones</option>
            </select>
          </Field>
          {(kind === 'hours' || kind === 'count') && (
            <Field label={kind === 'hours' ? 'Hours' : 'How many'}>
              <input className="input mono" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
            </Field>
          )}
          {kind === 'count' && (
            <Field label="Unit">
              <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
          )}
        </div>
        {kind === 'hours' && (
          <Field label="Counts these blocks automatically (unless you link missions to this target)">
            <div className="row wrap" style={{ gap: 10 }}>
              {HOUR_CATS.map((c) => (
                <label key={c} className="row" style={{ gap: 4, fontSize: 14 }}>
                  <input type="checkbox" checked={cats.includes(c)} onChange={() => setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])} />
                  {CATEGORY_META[c].short}
                </label>
              ))}
            </div>
          </Field>
        )}
        {kind === 'milestones' && (
          <Field label="Milestones (one per line)">
            <textarea className="textarea" value={items} onChange={(e) => setItems(e.target.value)} />
          </Field>
        )}
        {parentLevel && parents.length > 0 && (
          <Field label={`Part of a ${parentLevel} target`}>
            <select className="select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">— none —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Why it matters (optional — the coach reminds you)">
          <input className="input" value={why} onChange={(e) => setWhy(e.target.value)} />
        </Field>
      </div>
    </Sheet>
  );
}

// ---------------- calendar views ----------------

function DayView({ date, minute }: { date: string; minute: number }) {
  const doc = useStore((s) => s.doc);
  const now = minute * 60_000;
  const off = offsetOf(Date.now(), date, doc.settings.dayStart);
  const plan = planFor(doc, date);
  return (
    <div className="timeline">
      {liveBlocks(plan).map((b) => (
        <BlockRow
          key={b.id}
          doc={doc}
          date={date}
          block={b}
          current={off >= b.s && off < b.e}
          past={b.e <= off}
          sub={(plan.missions[b.id] ?? (b.origin ? plan.missions[b.origin] : undefined))?.title ?? `${CATEGORY_META[b.category].label} · ${fmtDur(b.e - b.s)}`}
          right={blockGlyph(doc, date, b, now)}
        />
      ))}
    </div>
  );
}

const PX_PER_MIN = 0.5;

function WeekView({ weekStart, minute }: { weekStart: string; minute: number }) {
  const doc = useStore((s) => s.doc);
  const open = useStore((s) => s.open);
  const now = minute * 60_000;
  const ds = doc.settings.dayStart;
  const days = weekDays(weekStart);
  const todayKey = today();
  return (
    <div className="week-grid" style={{ ['--h' as string]: `${1440 * PX_PER_MIN}px` }}>
      {days.map((d) => {
        const plan = planFor(doc, d);
        const nowOff = d === todayKey ? offsetOf(Date.now(), d, ds) : -1;
        return (
          <div key={d} className="week-col" data-today={d === todayKey}>
            <div className="week-head">
              <span>{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parseKey(d).getDay()]}</span>
              <strong>{parseKey(d).getDate()}</strong>
              {plan.rescue && <CircleDot size={10} color="var(--warn)" />}
            </div>
            <div className="week-body">
              {liveBlocks(plan).map((b) => {
                const glyph = blockGlyph(doc, d, b, now);
                return (
                  <button
                    key={b.id}
                    className="week-block"
                    title={`${b.title} · ${fmtClock(clockOf(b.s, ds))}–${fmtClock(clockOf(b.e, ds))}`}
                    style={{ top: b.s * PX_PER_MIN, height: Math.max(3, (b.e - b.s) * PX_PER_MIN - 1), background: catColor(b.category) }}
                    data-pinned={!!b.pinned}
                    onClick={() => open({ block: { date: d, blockId: b.id } })}
                  >
                    {(b.e - b.s) * PX_PER_MIN >= 16 && (
                      <span>
                        {glyph} {b.pinned ? '📌' : ''} {b.e - b.s >= 60 ? b.title : ''}
                      </span>
                    )}
                  </button>
                );
              })}
              {nowOff >= 0 && nowOff <= 1440 && <div className="week-now" style={{ top: nowOff * PX_PER_MIN }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function MonthView({ month, minute, onPick }: { month: string; minute: number; onPick: (d: string) => void }) {
  const doc = useStore((s) => s.doc);
  const now = minute * 60_000;
  const [from, to] = periodRange('month', month);
  const lead = (parseKey(from).getDay() + 6) % 7; // Monday first
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cells = useMemo(() => {
    const out: { date: string; value: number | null; rescued: boolean }[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const a = adherence(doc, d, now);
      const plan = doc.days[d];
      out.push({ date: d, value: a.counted ? a.value : null, rescued: !!plan && !plan.del && !!plan.rescue });
    }
    return out;
  }, [doc, from, to, minute]);
  const todayKey = today();
  return (
    <div className="month-grid">
      {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
        <span key={d} className="month-dow">
          {d}
        </span>
      ))}
      {Array.from({ length: lead }, (_, i) => (
        <span key={`e${i}`} />
      ))}
      {cells.map((c) => (
        <button
          key={c.date}
          className="month-cell"
          data-today={c.date === todayKey}
          onClick={() => onPick(c.date)}
          style={{ background: c.value === null ? undefined : `color-mix(in srgb, var(--ok) ${Math.round(15 + c.value * 70)}%, var(--surface))` }}
          title={c.value === null ? 'nothing tracked' : `${Math.round(c.value * 100)}% adherence`}
        >
          <span>{parseKey(c.date).getDate()}</span>
          {c.value !== null && <small>{Math.round(c.value * 100)}%</small>}
          {c.rescued && <i className="month-dot" />}
        </button>
      ))}
    </div>
  );
}
