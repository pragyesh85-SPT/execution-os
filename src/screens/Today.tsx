import { AnimatePresence, motion } from 'motion/react';
import { Check as CheckIcon, Crosshair, Flag, GitMerge, LifeBuoy, Pause, Play, Shield, ShieldOff, Sparkles, Square, Undo2, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { dayScore, minutesForBlock, missionFor, proofFor, wakeVerified } from '../core/engine';
import { entertainmentBalance, monthAdherence } from '../core/stats';
import type { PlanBlock } from '../core/types';
import { clockOf, fmtClock, fmtCountdown, fmtDur, longDate, MIN, weekKey } from '../core/time';
import { Dial } from '../components/Dial';
import { Bar, CatChip, Check, CountUp, EASE, RollingDigits, StatusPill, catColor, itemRise, listStagger } from '../components/ui';
import { clearProof, dismissRescue, saveProof, startSession, stopSession, toggleOutcome, toggleStep } from '../state/actions';
import { useToday } from '../state/hooks';
import { useStore } from '../state/store';
import { successTone, unlockAudio } from '../lib/sound';
import { SyncBadge } from '../components/SyncBadge';

export function Today() {
  const t = useToday();
  const { doc, now, date, plan, off, block, next, status, session, ds } = t;
  const open = useStore((s) => s.open);
  const setTab = useStore((s) => s.setTab);
  const conflictCount = useStore((s) => s.conflicts.length);

  const pendingProof = t.blocks.filter((b) => b.focus && b.e <= off && !proofFor(doc, date, b.id));

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Today</h1>
          <p>{longDate(date)}</p>
        </div>
        <div className="row wrap">
          <SyncBadge />
          <StatusPill state={status.state} />
        </div>
      </header>

      <div className="today">
        <div className="today-col">
          <AnimatePresence initial={false}>
            {status.state !== 'on_track' && (
              <motion.div
                key={status.title}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
                style={{ overflow: 'hidden' }}
              >
                <div className="banner" data-tone={status.state}>
                  {status.state === 'rescue' ? <LifeBuoy size={20} /> : <Zap size={20} />}
                  <div className="grow">
                    <h3>{status.title}</h3>
                    <p>{status.detail}</p>
                    <div className="btn-row">
                      {status.reason === 'wake' ? (
                        <button className="btn primary sm" onClick={() => open({ wake: true })}>
                          Verify wake
                        </button>
                      ) : (
                        status.block &&
                        status.block.e > off && (
                          <button
                            className="btn primary sm"
                            onClick={() => {
                              unlockAudio();
                              startSession(date, status.block!);
                              open({ focus: true });
                            }}
                          >
                            <Play size={14} /> Start the mission now
                          </button>
                        )
                      )}
                      <button className="btn sm" onClick={() => open({ rescue: true })}>
                        <LifeBuoy size={14} /> Rebuild my day
                      </button>
                      <button className="btn ghost sm" onClick={() => dismissRescue(date)}>
                        Not now
                      </button>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {conflictCount > 0 && (
            <div className="banner" data-tone="drifting">
              <GitMerge size={18} />
              <div className="grow">
                <h3>
                  {conflictCount} change{conflictCount > 1 ? 's' : ''} clash between devices
                </h3>
                <p>The same item was edited differently on two devices. Nothing was overwritten — choose which version to keep.</p>
                <button className="btn primary sm" onClick={() => open({ conflicts: true })}>
                  Review and choose
                </button>
              </div>
            </div>
          )}

          {pendingProof.length > 0 && (
            <div className="banner" data-tone="info">
              <Flag size={18} />
              <div className="grow">
                <h3>
                  {pendingProof.length} finished block{pendingProof.length > 1 ? 's' : ''} without proof
                </h3>
                <p>Record what actually got done — it is how the weekly review learns.</p>
                <div className="btn-row">
                  {pendingProof.slice(0, 3).map((b) => (
                    <button key={b.id} className="btn sm" onClick={() => open({ proof: { date, blockId: b.id } })}>
                      {b.title}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <NowCard block={block} />

          <section className="card">
            <h2 className="card-title">Next</h2>
            <motion.div className="next-list" variants={listStagger} initial="hidden" animate="show" key={next.map((b) => b.id).join()}>
              {next.length === 0 && <p className="muted">Nothing else today. Sleep is the next protected block.</p>}
              {next.map((b) => {
                const m = missionFor(plan, b);
                return (
                  <motion.div key={b.id} className="next-item" variants={itemRise}>
                    <span className="next-bar" style={{ background: catColor(b.category) }} />
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{b.title}</div>
                      <div className="m">{m ? m.title : CATEGORY_META[b.category].label}</div>
                    </div>
                    <div className="time">
                      {fmtClock(clockOf(b.s, ds))}
                      <br />
                      <span className="faint">in {fmtDur(b.s - off)}</span>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          </section>

          <Outcomes />

          <DayTimeline />
        </div>

        <div className="today-col">
          <section className="card">
            <Dial
              blocks={plan.blocks}
              dayStart={ds}
              nowOffset={off}
              done={(b) => {
                const p = proofFor(doc, date, b.id);
                return p?.status === 'done' || minutesForBlock(doc, date, b.id, now) > (b.e - b.s) * 0.7;
              }}
            />
            <div className="legend">
              {(['sleep', 'devotion', 'iit', 'founder', 'meal', 'care'] as const).map((c) => (
                <span key={c}>
                  <span className="dot" style={{ background: catColor(c) }} />
                  {CATEGORY_META[c].short}
                </span>
              ))}
            </div>
          </section>
          <ScoreCard />
          <QuickStats />
          {session && (
            <p className="faint" style={{ fontSize: 13, margin: 0 }}>
              Timer running since {new Date(session.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.
            </p>
          )}
          <ExperimentCard onOpen={() => setTab('review')} />
        </div>
      </div>
    </div>
  );
}

// ---------------- NOW card ----------------

function NowCard({ block }: { block: PlanBlock | undefined }) {
  const { doc, now, date, plan, off, session, ds } = useToday();
  const open = useStore((s) => s.open);
  const setTab = useStore((s) => s.setTab);
  const [urgeHint, setUrgeHint] = useState(false);

  if (!block) {
    return (
      <section className="card now-card">
        <div className="now-label">Now</div>
        <div className="now-title">Unplanned time</div>
        <p className="muted">This minute is not covered by any block. Edit the clock to give it a purpose.</p>
        <button className="btn" onClick={() => setTab('clock')}>
          Open clock editor
        </button>
      </section>
    );
  }

  const mission = missionFor(plan, block);
  const endMs = now + (block.e - off) * MIN;
  const elapsed = (off - block.s) / (block.e - block.s);
  const tracked = minutesForBlock(doc, date, block.id, now);
  const running = session?.blockId === block.id && session.date === date;
  const proof = proofFor(doc, date, block.id);
  const tracksTime = block.focus;
  const markable = !block.focus && CATEGORY_META[block.category].tracked;
  const pausedUntil = plan.guardPausedUntil && plan.guardPausedUntil > now ? plan.guardPausedUntil : null;

  return (
    <motion.section layoutId="focus-surface" className="card now-card" transition={{ duration: 0.35, ease: EASE }}>
      <div className="now-label">
        <span className="live" /> Now
        <span style={{ marginLeft: 'auto' }}>
          <CatChip category={block.category} />
        </span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={block.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25, ease: EASE }}>
          <h2 className="now-title">{block.title}</h2>
          <div className="now-range mono">
            {fmtClock(clockOf(block.s, ds))} → {fmtClock(clockOf(block.e, ds))}
            {block.rescued && <span className="chip" style={{ marginLeft: 8 }}>Rescued</span>}
            {block.exception && <span className="chip" style={{ marginLeft: 8 }}>Planned exception</span>}
          </div>

          {mission ? (
            <div className="now-mission">
              <div className="lbl">Objective</div>
              <div className="txt">{mission.title}</div>
              {mission.steps.length > 0 && (
                <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                  {mission.steps.map((s) => (
                    <div key={s.id} className="step-row">
                      <Check on={s.done} onChange={() => toggleStep(date, block, s.id)} label={s.text} />
                      <span style={{ color: s.done ? 'var(--ink-3)' : undefined, textDecoration: s.done ? 'line-through' : undefined, fontSize: 14 }}>{s.text}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            block.focus && (
              <div className="now-mission empty-m">
                <div className="row between wrap">
                  <span className="muted">No mission for this block yet — decide the one outcome before starting.</span>
                  <button className="btn sm" onClick={() => setTab('plan')}>
                    <Crosshair size={14} /> Set mission
                  </button>
                </div>
              </div>
            )
          )}
        </motion.div>
      </AnimatePresence>

      <div className="countdown">
        <RollingDigits text={fmtCountdown(endMs - now)} />
        <span className="muted">remaining</span>
      </div>
      <div className="progress" aria-hidden="true">
        <motion.i style={{ background: catColor(block.category), opacity: 0.35 }} animate={{ scaleX: Math.min(1, elapsed) }} transition={{ duration: 0.6, ease: EASE }} />
        {tracksTime && (
          <motion.i
            style={{ background: catColor(block.category) }}
            animate={{ scaleX: Math.min(1, tracked / (block.e - block.s)) }}
            transition={{ duration: 0.6, ease: EASE }}
          />
        )}
      </div>
      {tracksTime && (
        <div className="row between" style={{ marginTop: 6, fontSize: 12 }}>
          <span className="faint">Tracked {fmtDur(tracked)}</span>
          <span className="faint">{Math.round(Math.min(1, elapsed) * 100)}% of block elapsed</span>
        </div>
      )}

      <div className="now-actions">
        {tracksTime &&
          (running ? (
            <>
              <button className="btn primary" onClick={() => open({ focus: true })}>
                <Crosshair size={16} /> Enter focus
              </button>
              <button className="btn" onClick={() => stopSession()}>
                <Pause size={16} /> Pause
              </button>
              <button
                className="btn"
                onClick={() => {
                  stopSession();
                  open({ proof: { date, blockId: block.id } });
                }}
              >
                <Square size={14} /> Finish
              </button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                onClick={() => {
                  unlockAudio();
                  startSession(date, block);
                  open({ focus: true });
                }}
              >
                <Play size={16} /> {tracked > 0 ? 'Resume' : 'Start'} {CATEGORY_META[block.category].short}
              </button>
              {tracked > 0 && (
                <button className="btn" onClick={() => open({ proof: { date, blockId: block.id } })}>
                  <Flag size={14} /> Record proof
                </button>
              )}
            </>
          ))}
        {markable &&
          (proof?.status === 'done' ? (
            <button className="btn" onClick={() => clearProof(date, block.id)}>
              <Undo2 size={14} /> Undo done
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => {
                successTone();
                saveProof(date, block, 'done', '', [], []);
              }}
            >
              <CheckIcon size={16} /> Mark {CATEGORY_META[block.category].short.toLowerCase()} done
            </button>
          ))}
        {block.focus && (
          <button
            className="btn ghost"
            onClick={() => {
              setUrgeHint(false);
              open({ urge: true });
            }}
            onMouseEnter={() => setUrgeHint(true)}
            onMouseLeave={() => setUrgeHint(false)}
          >
            <Sparkles size={14} /> I feel an urge
          </button>
        )}
      </div>
      {urgeHint && <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>Capture the urge instead of acting on it — it goes to your Later list.</p>}

      {block.focus && (
        <div className="guard-line">
          {pausedUntil ? <ShieldOff size={16} /> : <Shield size={16} color="var(--ok)" />}
          {pausedUntil ? (
            <span>Focus Guard paused until {new Date(pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          ) : (
            <span>
              Focus protection: <strong>ON</strong> until {fmtClock(clockOf(block.e, ds))} · {doc.settings.focusBlock.length} sites blocked
            </span>
          )}
        </div>
      )}
    </motion.section>
  );
}

// ---------------- outcomes ----------------

function Outcomes() {
  const { plan, date } = useToday();
  const setTab = useStore((s) => s.setTab);
  const done = plan.outcomes.filter((o) => o.done).length;
  const all = plan.outcomes.length === 3 && done === 3;
  return (
    <section className="card">
      <h2 className="card-title">
        <span>3 daily outcomes</span>
        <span className="mono">
          {done}/{plan.outcomes.length || 3}
        </span>
      </h2>
      {plan.outcomes.length === 0 ? (
        <div className="empty">
          <strong>No outcomes chosen yet.</strong>
          <span>Pick the three results that would make today a success. Everything else is secondary.</span>
          <button className="btn sm" onClick={() => setTab('plan')}>
            Plan today's outcomes
          </button>
        </div>
      ) : (
        <div>
          {plan.outcomes.map((o, i) => (
            <div key={o.id} className="outcome" data-done={o.done}>
              <span className="num">{i + 1}</span>
              <Check
                on={o.done}
                onChange={() => {
                  if (!o.done) successTone();
                  toggleOutcome(date, o.id);
                }}
                label={o.text}
              />
              <span className="outcome-text">
                {o.text}
                <motion.span className="strike" initial={false} animate={{ width: o.done ? '100%' : '0%' }} transition={{ duration: 0.3, ease: EASE }} />
              </span>
              <span className="chip">{o.area === 'iit' ? 'IIT' : o.area === 'founder' ? 'Founder' : 'Personal'}</span>
            </div>
          ))}
          <AnimatePresence>
            {all && (
              <motion.div
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 24 }}
                className="banner"
                data-tone="info"
                style={{ marginTop: 12, background: 'var(--ok-soft)' }}
              >
                <Sparkles size={18} color="var(--ok)" />
                <div>
                  <h3>All three outcomes done</h3>
                  <p style={{ marginBottom: 0 }}>Optional entertainment is unlocked for the rest of today.</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

// ---------------- score ----------------

function ScoreCard() {
  const { doc, date, now } = useToday();
  const minuteBucket = Math.floor(now / 30_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const s = useMemo(() => dayScore(doc, date, now), [doc, date, minuteBucket]);
  return (
    <section className="card">
      <div className="score-head">
        <h2 className="card-title" style={{ margin: 0 }}>
          Day score
        </h2>
        <span className="score-num">
          <CountUp value={s.score} />
          <span style={{ fontSize: 20, color: 'var(--ink-3)' }}>%</span>
        </span>
      </div>
      <div className="score-rows">
        {s.wake !== 'off' && (
          <div className="score-row">
            <span>Sleep / wake</span>
            <Bar value={s.wake === 'done' ? 1 : s.wake === 'late' ? 0.5 : 0} color={catColor('sleep')} />
            <span className="v">{s.wake === 'done' ? 'on time ✓' : s.wake === 'late' ? 'late' : wakeVerified(doc, date) ? '✓' : 'pending'}</span>
          </div>
        )}
        {s.rows.map((r) => (
          <div key={r.category} className="score-row">
            <span>{CATEGORY_META[r.category].short === 'Care' ? 'Exercise / care' : CATEGORY_META[r.category].short}</span>
            <Bar value={r.target ? r.done / r.target : 0} color={catColor(r.category)} />
            <span className="v">
              {fmtDur(r.done)} / {fmtDur(r.target)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function QuickStats() {
  const { doc, date, now } = useToday();
  const bucket = Math.floor(now / 60_000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const data = useMemo(() => {
    const distraction = Object.values(doc.distractions)
      .filter((d) => !d.del && d.date === date && d.kind === 'unplanned')
      .reduce((a, d) => a + d.minutes, 0);
    const resisted = Object.values(doc.distractions).filter((d) => !d.del && d.date === date && d.kind === 'urge_resisted').length;
    const ent = entertainmentBalance(doc, weekKey(date), now);
    const adh = monthAdherence(doc, date, now);
    return { distraction, resisted, ent, adh };
  }, [doc, date, bucket]);
  const open = useStore((s) => s.open);
  const laterCount = Object.values(doc.later).filter((l) => !l.del && !l.done).length;
  return (
    <section className="stat-grid">
      <div className="stat">
        <div className="k">Distraction today</div>
        <div className="v">{fmtDur(data.distraction)}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          {data.resisted} urge{data.resisted === 1 ? '' : 's'} resisted
        </div>
      </div>
      <div className="stat">
        <div className="k">Entertainment balance</div>
        <div className="v" style={{ color: data.ent.remaining < 0 ? 'var(--bad)' : undefined }}>
          {data.ent.remaining < 0 ? '−' : ''}
          {fmtDur(Math.abs(data.ent.remaining))}
        </div>
        <div className="faint" style={{ fontSize: 12 }}>left this week</div>
      </div>
      <div className="stat">
        <div className="k">Adherence · 30 days</div>
        <div className="v">{data.adh.days ? `${Math.round(data.adh.value * 100)}%` : '—'}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          {data.adh.prev !== null ? `prev ${Math.round(data.adh.prev * 100)}%` : 'no streaks, just trend'}
        </div>
      </div>
      <button className="stat" style={{ border: 0, textAlign: 'left', cursor: 'pointer', gridColumn: '1 / -1' }} onClick={() => open({ later: true })}>
        <div className="k">Later list</div>
        <div className="row between">
          <span>{laterCount ? `${laterCount} saved for later` : 'Nothing saved — urges you capture land here'}</span>
          <span className="faint">Open →</span>
        </div>
      </button>
    </section>
  );
}

function ExperimentCard({ onOpen }: { onOpen: () => void }) {
  const { doc, date } = useToday();
  const prevWeek = Object.values(doc.reviews)
    .filter((r) => !r.del && r.change && r.id <= weekKey(date))
    .sort((a, b) => b.id.localeCompare(a.id))[0];
  if (!prevWeek) return null;
  return (
    <section className="card flat">
      <h2 className="card-title">This week's one change</h2>
      <p style={{ margin: 0 }}>{prevWeek.change}</p>
      <button className="btn ghost sm" style={{ marginTop: 8, paddingLeft: 0 }} onClick={onOpen}>
        Open weekly review →
      </button>
    </section>
  );
}

// ---------------- full day timeline ----------------

function DayTimeline() {
  const { doc, plan, date, off, now, ds } = useToday();
  const open = useStore((s) => s.open);
  const [expanded, setExpanded] = useState(false);
  const rows = plan.blocks;
  return (
    <section className="card">
      <h2 className="card-title">
        <span>Full day{plan.rescue ? ' · rescued plan' : ''}</span>
        <button className="btn ghost sm" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Show all'}
        </button>
      </h2>
      <motion.div className="timeline" layout>
        {rows
          .filter((b) => expanded || (b.e > off - 60 && b.s < off + 360))
          .map((b) => {
            const p = proofFor(doc, date, b.id);
            const tracked = minutesForBlock(doc, date, b.id, now);
            const current = !b.missed && off >= b.s && off < b.e;
            return (
              <motion.div
                layout
                key={b.id}
                className="tl-row"
                data-current={current}
                data-past={b.e <= off}
                data-missed={!!b.missed}
                onClick={() => b.focus && b.e <= off && !b.missed && open({ proof: { date, blockId: b.id } })}
                style={{ cursor: b.focus && b.e <= off ? 'pointer' : 'default' }}
              >
                <span className="tl-time">{fmtClock(clockOf(b.s, ds))}</span>
                <span className="tl-bar" style={{ background: catColor(b.category) }} />
                <div style={{ minWidth: 0 }}>
                  <div className="tl-title">{b.title}</div>
                  <div className="tl-sub">
                    {b.missed ? 'missed' : missionFor(plan, b)?.title ?? `${fmtDur(b.e - b.s)}`}
                  </div>
                </div>
                <span className="tl-sub mono">
                  {p ? (p.status === 'done' ? 'done ✓' : p.status === 'partial' ? 'partial' : 'not started') : tracked > 0 ? fmtDur(tracked) : ''}
                </span>
              </motion.div>
            );
          })}
      </motion.div>
    </section>
  );
}
