import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight, ClipboardCopy, ClipboardPaste, FlaskConical, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { parseReviewReply, REVIEW_SYSTEM, reviewUserPrompt } from '../core/planner';
import { monthAdherence, weekStats } from '../core/stats';
import { addDays, fmtClock, fmtDur, parseKey, shortDate, weekKey, WEEKDAYS } from '../core/time';
import { Bar, CountUp, EASE, Sheet, catColor, itemRise, listStagger } from '../components/ui';
import { saveReview, today } from '../state/actions';
import { useNow } from '../state/runtime';
import { useStore } from '../state/store';
import { aiComplete } from '../lib/ai';

export function Review() {
  const doc = useStore((s) => s.doc);
  const local = useStore((s) => s.local);
  const toast = useStore((s) => s.toast);
  const now = useNow();
  const minute = Math.floor(now / 60_000);
  const thisWeek = weekKey(today());
  const [week, setWeek] = useState(thisWeek);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const s = useMemo(() => weekStats(doc, week, now), [doc, week, minute]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const month = useMemo(() => monthAdherence(doc, today(), now), [doc, minute]);
  const review = doc.reviews[week];
  const [busy, setBusy] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState('');
  const apiReady = local.aiMode === 'api' && (local.ai.apiKey || local.ai.provider === 'compatible');
  const maxHour = Math.max(1, ...s.hourMinutes);
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const storeAi = (text: string) => {
    const { review: r, change } = parseReviewReply(text);
    saveReview({ id: week, summary: s.insights, change: change ?? review?.change ?? s.recommendation ?? undefined, aiText: r, at: Date.now() });
    toast('Weekly review saved.', 'success');
  };

  const runAi = async () => {
    setBusy(true);
    try {
      storeAi(await aiComplete(local.ai, REVIEW_SYSTEM, reviewUserPrompt(s), { maxTokens: 4000 }));
    } catch (err) {
      toast((err as Error).message, 'warn');
    } finally {
      setBusy(false);
    }
  };

  const delta = (cur: number, prev: number | null) => {
    if (prev === null) return null;
    const d = Math.round((cur - prev) * 100);
    if (d === 0) return <span className="delta faint">±0 pts</span>;
    return <span className={`delta ${d > 0 ? 'up' : 'down'}`}>{d > 0 ? `+${d}` : d} pts vs last week</span>;
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Weekly review</h1>
          <p>Observe → measure → adjust → repeat. One change per week, not ten.</p>
        </div>
        <div className="row">
          <button className="btn icon" aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}>
            <ChevronLeft size={18} />
          </button>
          <span className="mono" style={{ minWidth: 150, textAlign: 'center' }}>
            {shortDate(week)} – {shortDate(addDays(week, 6))}
          </span>
          <button className="btn icon" aria-label="Next week" disabled={week >= thisWeek} onClick={() => setWeek(addDays(week, 7))}>
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      <motion.div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', marginBottom: 24 }} variants={listStagger} initial="hidden" animate="show" key={week}>
        <motion.div className="card" variants={itemRise}>
          <div className="faint" style={{ fontSize: 13 }}>Adherence this week</div>
          <div className="big-num">
            <CountUp value={Math.round(s.adherence * 100)} />%
          </div>
          {delta(s.adherence, s.prevAdherence)}
        </motion.div>
        <motion.div className="card" variants={itemRise}>
          <div className="faint" style={{ fontSize: 13 }}>IIT completion</div>
          <div className="big-num">
            <CountUp value={Math.round(s.iitRate * 100)} />%
          </div>
          {delta(s.iitRate, s.prevIitRate)}
        </motion.div>
        <motion.div className="card" variants={itemRise}>
          <div className="faint" style={{ fontSize: 13 }}>Founder focus</div>
          <div className="big-num">{fmtDur(s.founderMinutes)}</div>
          <span className="faint" style={{ fontSize: 13 }}>tracked deep work</span>
        </motion.div>
        <motion.div className="card" variants={itemRise}>
          <div className="faint" style={{ fontSize: 13 }}>Unplanned distraction</div>
          <div className="big-num">{fmtDur(s.distractionMin)}</div>
          <span className="faint" style={{ fontSize: 13 }}>{s.topDistraction ? `mostly ${s.topDistraction}` : 'none logged'}</span>
        </motion.div>
        <motion.div className="card" variants={itemRise}>
          <div className="faint" style={{ fontSize: 13 }}>30-day adherence</div>
          <div className="big-num">{month.days ? pct(month.value) : '—'}</div>
          <span className="faint" style={{ fontSize: 13 }}>
            {month.prev !== null ? `${pct(month.prev)} → ${pct(month.value)}` : `${month.days} tracked days`}
          </span>
        </motion.div>
      </motion.div>

      <div className="review-grid">
        <section className="card">
          <h2 className="card-title">Daily adherence</h2>
          <div className="bars">
            {Array.from({ length: 7 }, (_, i) => {
              const date = addDays(week, i);
              const d = s.days.find((x) => x.date === date);
              const v = d?.counted ? d.adherence : 0;
              return (
                <div key={date} className="col" title={d ? `${pct(v)} · IIT ${fmtDur(d.iit)} · Founder ${fmtDur(d.founder)}` : 'future'}>
                  <div className="track">
                    <motion.div
                      className="fill"
                      style={{ height: '100%', background: v >= 0.7 ? 'var(--ok)' : v >= 0.4 ? 'var(--warn)' : 'var(--bad)', opacity: d?.counted ? 1 : 0 }}
                      initial={{ scaleY: 0 }}
                      animate={{ scaleY: v }}
                      transition={{ duration: 0.7, delay: i * 0.05, ease: EASE }}
                    />
                  </div>
                  <span>
                    {WEEKDAYS[parseKey(date).getDay()].slice(0, 3)}
                    {d?.rescued ? ' ·R' : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card">
          <h2 className="card-title">
            <span>When focus actually happens</span>
            {s.bestWindow && (
              <span className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
                best {fmtClock(s.bestWindow.start)}–{fmtClock(s.bestWindow.end)}
              </span>
            )}
          </h2>
          <div className="heat">
            {s.hourMinutes.map((m, h) => (
              <motion.i
                key={h}
                title={`${fmtClock(h * 60)} · ${fmtDur(m)}`}
                style={{ background: m ? 'var(--cat-founder)' : 'var(--surface-2)' }}
                initial={{ opacity: 0 }}
                animate={{ opacity: m ? 0.2 + 0.8 * (m / maxHour) : 1 }}
                transition={{ duration: 0.5, delay: h * 0.015 }}
              />
            ))}
          </div>
          <div className="heat-axis">
            <span>12 AM</span>
            <span>6 AM</span>
            <span>12 PM</span>
            <span>6 PM</span>
          </div>
          <div className="divider" />
          <h3 className="card-title">Slot success rate</h3>
          {s.slots.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Finish a few focus blocks and their success rates appear here.</p>
          ) : (
            <div className="score-rows" style={{ marginTop: 0 }}>
              {s.slots.map((x) => (
                <div key={x.key} className="score-row">
                  <span>{x.label}</span>
                  <Bar value={x.rate} color={catColor(x.category)} />
                  <span className="v">
                    {pct(x.rate)} · n={x.scheduled}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">What the week says</h2>
          {s.insights.length === 0 ? (
            <div className="empty">
              <strong>Not enough data yet.</strong>
              <span>Use Start / Finish on blocks and record proof — insights build from that.</span>
            </div>
          ) : (
            <motion.div variants={listStagger} initial="hidden" animate="show" key={`ins-${week}`}>
              {s.insights.map((t, i) => (
                <motion.div key={i} className="insight" variants={itemRise}>
                  <span className="n">{String(i + 1).padStart(2, '0')}</span>
                  <span>{t}</span>
                </motion.div>
              ))}
            </motion.div>
          )}
          {s.weekday.length > 0 && (
            <p className="faint" style={{ fontSize: 13, marginBottom: 0 }}>
              Weekday ranking: {s.weekday.map((w) => `${w.day.slice(0, 3)} ${pct(w.rate)}`).join(' · ')}
            </p>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">
            <span>One change for next week</span>
            <FlaskConical size={16} />
          </h2>
          {s.recommendation ? (
            <p style={{ marginTop: 0, fontSize: 16 }}>{s.recommendation}</p>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>
              No recommendation yet — a few more tracked days are needed.
            </p>
          )}
          {review?.change && (
            <div className="banner" data-tone="info" style={{ marginBottom: 12 }}>
              <FlaskConical size={16} />
              <div>
                <h3>Adopted experiment</h3>
                <p style={{ margin: 0 }}>{review.change}</p>
              </div>
            </div>
          )}
          <div className="btn-row">
            {s.recommendation && (
              <button
                className="btn"
                onClick={() => {
                  saveReview({ id: week, summary: s.insights, change: s.recommendation!, aiText: review?.aiText, at: Date.now() });
                  toast('Adopted. It will show on Today as this week’s one change.', 'success');
                }}
              >
                Adopt this change
              </button>
            )}
          </div>
          <div className="divider" />
          <h3 className="card-title">AI narrative (optional)</h3>
          {review?.aiText ? <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{review.aiText}</p> : <p className="muted" style={{ marginTop: 0 }}>The AI only explains these measured numbers — it never invents data.</p>}
          <div className="btn-row">
            {apiReady && (
              <button className="btn primary" disabled={busy} onClick={runAi}>
                <Sparkles size={16} /> {busy ? 'Writing…' : 'Write review with AI'}
              </button>
            )}
            <button
              className="btn ghost"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${REVIEW_SYSTEM}\n\n---\n\n${reviewUserPrompt(s)}`);
                  toast('Review prompt copied.', 'success');
                } catch {
                  toast('Clipboard blocked — select the text manually.', 'warn');
                }
              }}
            >
              <ClipboardCopy size={16} /> Copy prompt
            </button>
            <button className="btn ghost" onClick={() => setPasteOpen(true)}>
              <ClipboardPaste size={16} /> Paste reply
            </button>
          </div>
        </section>
      </div>

      <section className="card" style={{ marginTop: 24 }}>
        <h2 className="card-title">Day by day</h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr className="faint" style={{ textAlign: 'left' }}>
                {['Day', 'Score', 'Adherence', CATEGORY_META.iit.short, CATEGORY_META.founder.short, CATEGORY_META.devotion.short, 'Distraction', 'Outcomes', ''].map((h) => (
                  <th key={h} style={{ padding: '8px 8px 8px 0', fontWeight: 500, fontSize: 12 }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="mono">
              {s.days.map((d) => (
                <tr key={d.date} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '8px 8px 8px 0', fontFamily: 'var(--font-ui)' }}>
                    {WEEKDAYS[parseKey(d.date).getDay()].slice(0, 3)} {shortDate(d.date)}
                  </td>
                  <td>{d.score}%</td>
                  <td>{d.counted ? pct(d.adherence) : '—'}</td>
                  <td>{fmtDur(d.iit)}</td>
                  <td>{fmtDur(d.founder)}</td>
                  <td>{fmtDur(d.devotion)}</td>
                  <td>{fmtDur(d.distraction)}</td>
                  <td>
                    {d.outcomesDone}/{d.outcomesTotal || 3}
                  </td>
                  <td className="faint">{d.rescued ? 'rescued' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Sheet
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        title="Paste the AI's review"
        subtitle="Expected format: REVIEW: … CHANGE: …"
        footer={
          <button
            className="btn primary"
            disabled={!paste.trim()}
            onClick={() => {
              storeAi(paste);
              setPaste('');
              setPasteOpen(false);
            }}
          >
            Save review
          </button>
        }
      >
        <textarea className="textarea" style={{ minHeight: 200 }} value={paste} onChange={(e) => setPaste(e.target.value)} />
      </Sheet>
    </div>
  );
}
