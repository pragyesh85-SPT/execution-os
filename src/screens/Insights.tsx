import { Gavel, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { analytics, lastNDays, rolling, type Analytics } from '../core/analytics';
import { coachVerdict, latestNote } from '../core/coach';
import { CATEGORY_META } from '../core/defaults';
import { addDays, fmtDur, weekKey } from '../core/time';
import { Bar, Segmented, catColor } from '../components/ui';
import { attempt, postCoachingNote, saveRule, today, uid } from '../state/actions';
import { useFlag } from '../state/hooks';
import { useNow } from '../state/runtime';
import { useStore } from '../state/store';
import { openExternal } from '../lib/platform';

// Insights: plan versus reality (Analytics) and the weekly Coach card. Every number comes from
// src/core/analytics.ts and src/core/coach.ts; nothing here computes a metric of its own.

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function AnalyticsSection() {
  const doc = useStore((s) => s.doc);
  const now = useNow();
  const minute = Math.floor(now / 300_000);
  const [days, setDays] = useState<'7' | '28' | '90'>('28');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const a = useMemo(() => {
    const [from, to] = lastNDays(today(), Number(days));
    return analytics(doc, from, to, now);
  }, [doc, days, minute]);
  return (
    <section className="card">
      <div className="row between wrap" style={{ marginBottom: 12, gap: 8 }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          Analytics · plan vs reality
        </h2>
        <Segmented
          id="an-range"
          value={days}
          onChange={setDays}
          options={[
            { value: '7', label: '7 days' },
            { value: '28', label: '28 days' },
            { value: '90', label: '90 days' },
          ]}
        />
      </div>
      {a.finishedFocus === 0 ? (
        <div className="empty">
          <strong>Nothing finished in this range yet.</strong>
          <span>Analytics fill in as focus blocks end and get logged.</span>
        </div>
      ) : (
        <div className="stack lg">
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Tile k="Verified deep work" v={`${Math.round(a.deepWorkHours * 10) / 10} h`} sub={`${a.completion.done + a.completion.partial} logged blocks`} />
            <Tile k="On-time starts" v={pct(a.onTime.rate)} sub={`${a.onTime.count} of ${a.finishedFocus} focus blocks`} />
            <Tile k="Mission completion" v={pct(a.completion.rate)} sub={`${a.completion.done} done · ${a.completion.partial} partial · ${a.completion.none} not started · ${a.completion.unlogged} unlogged`} />
            <Tile k="Drift" v={fmtDur(a.drift.total)} sub={`${fmtDur(a.drift.lateMinutes)} late starts · ${fmtDur(a.drift.distractionMinutes)} distraction`} />
            <Tile k="Rescues" v={`${Math.round(a.rescues.perWeek * 10) / 10}/wk`} sub={reasonText(a)} />
            <Tile k="Focus quality" v={fmtDur(a.focus.avgSession)} sub={`average session · longest ${fmtDur(a.focus.longestSession)}`} />
            {a.overrides.swap + a.overrides.borrow + a.overrides.drift > 0 && (
              <Tile k="Something else" v={`${a.overrides.swap} swaps`} sub={`${a.overrides.borrow} borrowed detours · ${a.overrides.drift} marked as drift`} />
            )}
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <strong style={{ fontSize: 14 }}>Trend (rolling 7 days)</strong>
            <Spark label="Deep work h/day" values={rolling(a.daily.map((d) => d.deepWorkHours))} max={Math.max(1, ...a.daily.map((d) => d.deepWorkHours))} fmt={(v) => `${Math.round(v * 10) / 10}h`} />
            <Spark label="Completion" values={rolling(a.daily.map((d) => d.completion))} max={1} fmt={(v) => pct(v)} />
            <Spark label="On time" values={rolling(a.daily.map((d) => d.onTime))} max={1} fmt={(v) => pct(v)} />
          </div>

          <div className="stack" style={{ gap: 6 }}>
            <strong style={{ fontSize: 14 }}>Where time leaks (late starts + distraction, by hour and weekday)</strong>
            <Heat heat={a.drift.heat} />
          </div>

          <div className="grid-2">
            <div className="stack" style={{ gap: 8 }}>
              <strong style={{ fontSize: 14 }}>How realistic the plan is</strong>
              {a.planAccuracy.byCategory.map((c) => (
                <div key={c.category} className="score-row">
                  <span>{CATEGORY_META[c.category].short}</span>
                  <Bar value={Math.min(1, c.ratio)} color={catColor(c.category)} />
                  <span className="v">
                    {fmtDur(c.actual)} / {fmtDur(c.planned)}
                  </span>
                </div>
              ))}
              {a.planAccuracy.estimateRatio !== null && <span className="faint" style={{ fontSize: 13 }}>Missions take {Math.round(a.planAccuracy.estimateRatio * 100)}% of their estimate.</span>}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              <strong style={{ fontSize: 14 }}>Anchors kept</strong>
              <div className="score-row">
                <span>Wake on time</span>
                <Bar value={a.anchors.wakeOnTime ?? 0} color={catColor('sleep')} />
                <span className="v">{pct(a.anchors.wakeOnTime)}</span>
              </div>
              <div className="score-row">
                <span>Devotion min.</span>
                <Bar value={a.anchors.devotionMet ?? 0} color={catColor('devotion')} />
                <span className="v">{pct(a.anchors.devotionMet)}</span>
              </div>
              <div className="score-row">
                <span>Study min.</span>
                <Bar value={a.anchors.studyMet ?? 0} color={catColor('iit')} />
                <span className="v">{pct(a.anchors.studyMet)}</span>
              </div>
              <span className="faint" style={{ fontSize: 13 }}>
                Entertainment: {fmtDur(a.entertainment.planned)} planned + {fmtDur(a.entertainment.unplanned)} unplanned of a {fmtDur(a.entertainment.budget)} budget.
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function reasonText(a: Analytics) {
  const r = Object.entries(a.rescues.reasons).filter(([, n]) => n > 0);
  if (!r.length) return 'none needed';
  const label: Record<string, string> = { wake: 'late wake', not_started: 'block not started', missed_protected: 'minimum missed', manual: 'by hand' };
  return r.map(([k, n]) => `${n} ${label[k]}`).join(' · ');
}

function Tile({ k, v, sub }: { k: string; v: string; sub: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="faint" style={{ fontSize: 12 }}>
        {sub}
      </div>
    </div>
  );
}

function Spark({ label, values, max, fmt }: { label: string; values: (number | null)[]; max: number; fmt: (v: number) => string }) {
  const w = 240;
  const h = 32;
  const pts = values.map((v, i) => (v === null ? null : [values.length > 1 ? (i / (values.length - 1)) * w : w / 2, h - 2 - (v / max) * (h - 4)])).filter((p): p is number[] => !!p);
  const last = [...values].reverse().find((v) => v !== null) ?? null;
  return (
    <div className="row" style={{ gap: 10, fontSize: 13 }}>
      <span className="faint" style={{ width: 120 }}>
        {label}
      </span>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label} trend`} style={{ flex: 'none', maxWidth: '45vw' }}>
        <line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="var(--line)" />
        {pts.length > 1 && <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />}
      </svg>
      <span className="mono">{last === null ? '—' : fmt(last)}</span>
    </div>
  );
}

function Heat({ heat }: { heat: number[][] }) {
  const max = Math.max(1, ...heat.flat());
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="heat" role="table" aria-label="Minutes lost by weekday and hour">
      <span />
      {hours.map((h) => (
        <span key={h} className="heat-h">
          {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
        </span>
      ))}
      {heat.map((row, wd) => (
        <div key={wd} style={{ display: 'contents' }}>
          <span className="heat-d">{WD[wd]}</span>
          {row.map((m, h) => (
            <span key={h} className="heat-c" title={`${WD[wd]} ${String(h).padStart(2, '0')}:00 · ${fmtDur(m)}`} style={{ background: m ? `color-mix(in srgb, var(--bad) ${Math.round(15 + (m / max) * 75)}%, var(--surface-2))` : undefined }} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------- coach ----------------

export function CoachCard() {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const now = useNow();
  const minute = Math.floor(now / 300_000);
  const mcp = useFlag('mcp');
  const thisWeek = weekKey(today());
  const [week, setWeek] = useState(addDays(thisWeek, -7));
  const note = latestNote(doc, week);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const live = useMemo(() => coachVerdict(doc, week, addDays(week, 6), now), [doc, week, minute]);
  const card = note ?? { ...live, source: 'engine' as const, text: undefined, change: live.change, wentWell: live.wentWell, leak: live.leak };
  const ruleExists = Object.values(doc.rules).some((r) => !r.del && r.cue === card.change.cue);
  const gradeColor = { A: 'var(--ok)', B: 'var(--ok)', C: 'var(--warn)', D: 'var(--bad)', F: 'var(--bad)' }[card.grade as 'A'] ?? 'var(--ink-3)';
  return (
    <section className="card coach-card">
      <div className="row between wrap" style={{ gap: 8 }}>
        <h2 className="card-title" style={{ margin: 0 }}>
          <Gavel size={14} /> Coach · week of {week}
        </h2>
        <Segmented
          id="coach-week"
          value={week === thisWeek ? 'this' : 'last'}
          onChange={(v) => setWeek(v === 'this' ? thisWeek : addDays(thisWeek, -7))}
          options={[
            { value: 'last', label: 'Last week' },
            { value: 'this', label: 'This week so far' },
          ]}
        />
      </div>
      <div className="coach-head">
        <span className="coach-grade" style={{ color: gradeColor }}>
          {card.grade === 'Not enough data' ? '—' : card.grade}
        </span>
        <div>
          <div style={{ fontWeight: 600 }}>{card.profile}</div>
          <div className="faint" style={{ fontSize: 13 }}>
            {card.grade === 'Not enough data' ? 'At least 5 finished focus blocks are needed for a grade.' : `Score ${card.score} — computed by Execution OS; no AI can round it up.`}
          </div>
        </div>
      </div>
      <ul style={{ margin: '12px 0 0', paddingLeft: 18, display: 'grid', gap: 4, fontSize: 14 }}>
        {card.evidence.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <div className="stack" style={{ gap: 6, marginTop: 12, fontSize: 14 }}>
        {card.wentWell && (
          <div>
            <strong>Went well:</strong> {card.wentWell}
          </div>
        )}
        <div>
          <strong>Biggest leak:</strong> {card.leak}
        </div>
        <div>
          <strong>One change:</strong> {card.change.cue}
        </div>
        {card.text && <p style={{ margin: 0, color: 'var(--ink-2)' }}>{card.text}</p>}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        {card.change.trigger && card.change.action && (
          <button
            className="btn primary sm"
            disabled={ruleExists}
            onClick={() => {
              if (attempt(() => saveRule({ id: uid('r'), enabled: true, trigger: card.change.trigger!, action: card.change.action!, cue: card.change.cue }))) toast('Rule added. It runs from now on.', 'success');
            }}
          >
            <Plus size={14} /> {ruleExists ? 'Rule added' : 'Add rule'}
          </button>
        )}
        {!note && (
          <button className="btn sm" onClick={() => attempt(() => postCoachingNote(week, {}, 'engine')) && toast('Coaching card saved for this week.', 'success')}>
            Save this card
          </button>
        )}
        {mcp && (
          <button
            className="btn ghost sm"
            onClick={async () => {
              const text = `Run my weekly review for the week starting ${week} in Execution OS`;
              try {
                await navigator.clipboard.writeText(text);
                toast('Copied. Paste it into the new Claude chat.', 'success');
              } catch {
                toast(text, 'info');
              }
              openExternal('https://claude.ai/new');
            }}
          >
            <Sparkles size={14} /> Ask Claude to narrate
          </button>
        )}
      </div>
    </section>
  );
}
