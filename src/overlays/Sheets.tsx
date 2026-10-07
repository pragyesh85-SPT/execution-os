import { AnimatePresence, motion } from 'motion/react';
import { CircleCheck, CircleDashed, CircleSlash, GitCommitHorizontal, Link2, Trash, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { minutesForBlock, missionFor, planFor, proofFor } from '../core/engine';
import type { ProofStatus } from '../core/types';
import { clockOf, dayStartMs, fmtClock, fmtDur, MIN, offsetOf } from '../core/time';
import { Check, EASE, Field, Sheet, catColor } from '../components/ui';
import { addException, addLater, deleteLater, logDistraction, pauseGuard, saveProof, toggleLater, today, updateSettings, updateTask } from '../state/actions';
import { useToday } from '../state/hooks';
import { useStore } from '../state/store';
import { githubProof } from '../lib/github';
import { requestNotifications } from '../lib/notify';
import { successTone, unlockAudio } from '../lib/sound';

// ---------------- proof of work ----------------

const STATUS_OPTIONS: { value: ProofStatus; label: string; desc: string; icon: typeof CircleCheck; color: string }[] = [
  { value: 'done', label: 'Completed', desc: 'The mission is done', icon: CircleCheck, color: 'var(--ok)' },
  { value: 'partial', label: 'Partially', desc: 'Progress, not finished', icon: CircleDashed, color: 'var(--warn)' },
  { value: 'none', label: "Didn't start", desc: 'Honest beats flattering', icon: CircleSlash, color: 'var(--bad)' },
];

export function ProofSheet() {
  const target = useStore((s) => s.overlay.proof);
  const open = useStore((s) => s.open);
  return (
    <AnimatePresence>
      {target && <ProofInner key={`${target.date}:${target.blockId}`} date={target.date} blockId={target.blockId} onClose={() => open({ proof: undefined })} />}
    </AnimatePresence>
  );
}

function ProofInner({ date, blockId, onClose }: { date: string; blockId: string; onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const local = useStore((s) => s.local);
  const toast = useStore((s) => s.toast);
  const plan = planFor(doc, date);
  const block = plan.blocks.find((b) => b.id === blockId);
  const existing = proofFor(doc, date, blockId);
  const [status, setStatus] = useState<ProofStatus | null>(existing?.status ?? null);
  const [note, setNote] = useState(existing?.note ?? '');
  const [links, setLinks] = useState((existing?.links ?? []).join('\n'));
  const [auto, setAuto] = useState<string[]>(existing?.auto ?? []);
  const [autoState, setAutoState] = useState<'idle' | 'loading' | 'error'>('idle');
  const mission = block ? missionFor(plan, block) : undefined;
  const linkedTask = mission ? Object.values(doc.tasks).find((t) => !t.del && !t.done && t.title.trim().toLowerCase() === mission.title.trim().toLowerCase()) : undefined;
  const [closeTask, setCloseTask] = useState(true);

  useEffect(() => {
    if (!block || block.category !== 'founder' || !doc.settings.githubUser || existing?.auto.length) return;
    const start = dayStartMs(date, doc.settings.dayStart) + block.s * MIN;
    const end = dayStartMs(date, doc.settings.dayStart) + block.e * MIN;
    setAutoState('loading');
    githubProof(doc.settings.githubUser, local.githubToken || undefined, start, Math.min(end, Date.now()))
      .then((r) => {
        setAuto(r);
        setAutoState('idle');
      })
      .catch(() => setAutoState('error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!block) return null;
  const tracked = minutesForBlock(doc, date, block.id, Date.now());
  const ds = doc.settings.dayStart;

  return (
    <Sheet
      open
      onClose={onClose}
      title="What actually got done?"
      subtitle={
        <>
          <span className="dot" style={{ background: catColor(block.category), display: 'inline-block', marginRight: 6 }} />
          {block.title} · {fmtClock(clockOf(block.s, ds))}–{fmtClock(clockOf(block.e, ds))} · tracked {fmtDur(tracked)} of {fmtDur(block.e - block.s)}
        </>
      }
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Later
          </button>
          <button
            className="btn primary"
            disabled={!status}
            onClick={() => {
              if (!status) return;
              saveProof(
                date,
                block,
                status,
                note.trim(),
                links
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean),
                auto,
              );
              if (status === 'done' && linkedTask && closeTask) updateTask(linkedTask.id, { done: true });
              if (status === 'done') successTone();
              toast(status === 'done' ? 'Proof recorded. Block complete.' : 'Recorded honestly. The weekly review will learn from it.', status === 'done' ? 'success' : 'info');
              onClose();
            }}
          >
            Save proof
          </button>
        </>
      }
    >
      <div className="stack lg">
        {mission && (
          <div className="now-mission" style={{ marginTop: 0 }}>
            <div className="lbl">Mission</div>
            <div className="txt">{mission.title}</div>
            {mission.steps.length > 0 && (
              <div className="faint" style={{ fontSize: 13, marginTop: 4 }}>
                {mission.steps.filter((s) => s.done).length}/{mission.steps.length} steps checked
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {STATUS_OPTIONS.map((o) => {
            const Icon = o.icon;
            const on = status === o.value;
            return (
              <motion.button
                key={o.value}
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => setStatus(o.value)}
                style={{
                  display: 'grid',
                  gap: 6,
                  justifyItems: 'start',
                  padding: 14,
                  borderRadius: 10,
                  border: `1.5px solid ${on ? o.color : 'var(--line-strong)'}`,
                  background: on ? 'var(--surface-2)' : 'var(--surface)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'border-color 160ms, background-color 160ms',
                }}
              >
                <Icon size={20} color={o.color} />
                <span style={{ fontWeight: 600 }}>{o.label}</span>
                <span className="faint" style={{ fontSize: 12 }}>
                  {o.desc}
                </span>
              </motion.button>
            );
          })}
        </div>
        {(auto.length > 0 || autoState !== 'idle') && (
          <div className="stack" style={{ gap: 6 }}>
            <span className="row faint" style={{ fontSize: 13, gap: 6 }}>
              <GitCommitHorizontal size={14} /> Detected automatically
            </span>
            {autoState === 'loading' && <span className="faint">Checking GitHub…</span>}
            {autoState === 'error' && <span className="faint">GitHub could not be reached.</span>}
            <div className="row wrap" style={{ gap: 6 }}>
              {auto.map((a) => (
                <span key={a} className="chip" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>
                  {a}
                </span>
              ))}
            </div>
          </div>
        )}
        <Field label="Note (optional)">
          <textarea className="textarea" style={{ minHeight: 70 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Submitted Q1–Q4, Q5 needs one more hour" />
        </Field>
        <Field label="Links (optional, one per line)" hint="Assignment submission, PR, doc…">
          <div className="row" style={{ alignItems: 'start' }}>
            <Link2 size={16} style={{ marginTop: 11 }} className="faint" />
            <textarea className="textarea mono" style={{ minHeight: 56, fontSize: 13 }} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="https://github.com/…/pull/218" />
          </div>
        </Field>
        {linkedTask && status === 'done' && (
          <label className="row" style={{ fontSize: 14 }}>
            <Check on={closeTask} onChange={() => setCloseTask(!closeTask)} label="Close task" />
            Also mark the task “{linkedTask.title}” as done
          </label>
        )}
      </div>
    </Sheet>
  );
}

// ---------------- urge capture ----------------

export function UrgeSheet() {
  const open = useStore((s) => s.overlay.urge);
  const setOpen = useStore((s) => s.open);
  const toast = useStore((s) => s.toast);
  const doc = useStore((s) => s.doc);
  const { block, plan } = useToday();
  const [text, setText] = useState('');
  const rule = Object.values(doc.rules).find((r) => !r.del && r.enabled && r.trigger.type === 'urge');
  const quick = ['YouTube video', 'Instagram', 'Netflix episode', 'Reddit thread', 'X / Twitter', 'Movie'];
  const close = () => {
    setText('');
    setOpen({ urge: false });
  };
  const save = (what: string) => {
    if (!what.trim()) return;
    addLater(what.trim(), /^https?:\/\//.test(what.trim()) ? what.trim() : undefined);
    logDistraction(0, what.trim().split(' ')[0], 'urge_resisted');
    toast(`Saved to Later. Back to: ${block ? missionFor(plan, block)?.title ?? block.title : 'your block'}`, 'success');
    close();
  };
  return (
    <Sheet open={open} onClose={close} title="Park the urge" subtitle={rule ? rule.cue : 'Save it for later instead of opening it. It will still be there after the block.'}>
      <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>
          {quick.map((q) => (
            <button key={q} className="chip" style={{ border: 0, cursor: 'pointer', height: 32 }} onClick={() => save(q)}>
              {q}
            </button>
          ))}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            save(text);
          }}
        >
          <input className="input grow" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What were you about to open? (or paste the link)" />
          <button className="btn primary" type="submit" disabled={!text.trim()}>
            Save for later
          </button>
        </form>
      </div>
    </Sheet>
  );
}

// ---------------- later list ----------------

export function LaterSheet() {
  const open = useStore((s) => s.overlay.later);
  const setOpen = useStore((s) => s.open);
  const doc = useStore((s) => s.doc);
  const [text, setText] = useState('');
  const items = Object.values(doc.later)
    .filter((l) => !l.del)
    .sort((a, b) => Number(a.done) - Number(b.done) || b.at - a.at);
  return (
    <Sheet open={open} onClose={() => setOpen({ later: false })} title="Later" subtitle="Things you chose not to open during focus. Enjoy them guilt-free in a planned slot.">
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          addLater(text.trim(), /^https?:\/\//.test(text.trim()) ? text.trim() : undefined);
          setText('');
        }}
      >
        <input className="input grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add something for later" />
        <button className="btn" type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {items.length === 0 ? (
        <div className="empty">
          <strong>Nothing saved.</strong>
          <span>Use “I feel an urge” during focus, or the browser extension's “Save for later”.</span>
        </div>
      ) : (
        <motion.div layout>
          <AnimatePresence initial={false}>
            {items.map((l) => (
              <motion.div key={l.id} layout className="task" data-done={l.done} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.2, ease: EASE }}>
                <Check on={l.done} onChange={() => toggleLater(l.id)} label={l.text} />
                <div style={{ minWidth: 0 }}>
                  <div className="ttl" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.url ? (
                      <a href={l.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                        {l.text}
                      </a>
                    ) : (
                      l.text
                    )}
                  </div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    saved {new Date(l.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
                <button className="btn ghost icon sm" aria-label="Delete" onClick={() => deleteLater(l.id)}>
                  <Trash size={14} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </Sheet>
  );
}

// ---------------- Focus Guard nudge (from the Windows watcher) ----------------

export function GuardNudge() {
  const guard = useStore((s) => s.overlay.guard);
  const setOpen = useStore((s) => s.open);
  const toast = useStore((s) => s.toast);
  const { block, plan, date, ds, off } = useToday();
  const close = () => setOpen({ guard: undefined });
  const mission = block ? missionFor(plan, block)?.title : undefined;
  return (
    <Sheet
      open={!!guard}
      onClose={close}
      title={`${guard?.source ?? 'Distraction'} during ${block ? CATEGORY_META[block.category].short : 'focus'}`}
      subtitle={block ? `Focus block until ${fmtClock(clockOf(block.e, ds))}.${mission ? ` Mission: ${mission}` : ''}` : undefined}
      footer={
        <>
          <button
            className="btn ghost"
            onClick={() => {
              const s = Math.floor(off);
              addException(date, s, Math.min(1440, s + 30), `Break · ${guard?.source ?? 'entertainment'}`);
              toast('Logged as a planned 30-minute break. It counts against this week’s entertainment budget.', 'info');
              close();
            }}
          >
            Make it a planned break
          </button>
          <button
            className="btn"
            onClick={() => {
              addLater(guard?.title ?? guard?.source ?? 'Saved');
              logDistraction(0, guard?.source ?? 'Window', 'urge_resisted');
              toast('Saved for later.', 'success');
              close();
            }}
          >
            Save it for later
          </button>
          <button className="btn primary" onClick={close}>
            Back to the mission
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>
        “{guard?.title}” has been in front for a while. Nothing is blocked by force here — choose on purpose.
      </p>
    </Sheet>
  );
}

// ---------------- toasts ----------------

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            className="toast"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          >
            <span className="dot" style={{ background: t.tone === 'success' ? 'var(--ok)' : t.tone === 'warn' ? 'var(--warn)' : 'var(--accent)' }} />
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button aria-label="Dismiss" onClick={() => dismiss(t.id)} style={{ color: 'inherit', opacity: 0.6 }}>
              <X size={14} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ---------------- first run ----------------

export function Welcome() {
  const show = useStore((s) => s.overlay.welcome);
  const onboarded = useStore((s) => s.doc.settings.onboarded);
  const name0 = useStore((s) => s.doc.settings.name);
  const wake0 = useStore((s) => s.doc.settings.wakeGate);
  const setOpen = useStore((s) => s.open);
  const setTab = useStore((s) => s.setTab);
  const [name, setName] = useState(name0);
  const [wake, setWake] = useState(wake0);
  const doc = useStore((s) => s.doc);
  const now = Date.now();
  const missedToday = offsetOf(now, today(), doc.settings.dayStart) > doc.settings.wakeGraceMin;

  const finish = async (goClock: boolean) => {
    unlockAudio();
    await requestNotifications().catch(() => false);
    updateSettings({ name: name.trim() || 'PJ', wakeGate: wake, onboarded: true, startedOn: doc.settings.startedOn ?? today() });
    // Do not ring a wake alarm for a morning that already passed before the app was installed.
    if (wake && missedToday) {
      useStore.getState().update((d, t) => {
        const date = today();
        d.wake[date] = { id: date, u: t, verifiedAt: t, method: 'bypass', lateMin: 0 };
      });
    }
    setOpen({ welcome: false });
    if (goClock) setTab('clock');
  };

  return (
    <Sheet open={show && !onboarded} onClose={() => {}} dismissable={false} title="Execution OS" subtitle="Given what has actually happened today, what is the single best thing to do now?">
      <div className="stack lg">
        <div className="welcome-steps">
          {[
            ['Protect four things', 'Sleep → Devotion → IIT → Founder. Meals, care and breaks live around them.'],
            ['One mission per block', 'Not “study” — “Finish Assignment 3, Q1–Q5”. Set them on the Plan page, by hand or with AI.'],
            ['Drift is expected', 'Late? The status turns amber, then red, and Rescue Mode rebuilds the rest of the day.'],
            ['Proof, not presence', 'At the end of each focus block, record what actually got done.'],
          ].map(([t, d], i) => (
            <motion.div key={t} className="welcome-step" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.08, duration: 0.3, ease: EASE }}>
              <span className="n">{i + 1}</span>
              <div>
                <strong>{t}</strong>
                <div className="muted" style={{ fontSize: 14 }}>
                  {d}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
        <Field label="What should Execution OS call you?">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <label className="row" style={{ fontSize: 14 }}>
          <Check on={wake} onChange={() => setWake(!wake)} label="Wake Gate" />
          Use the Wake Gate at 4:00 AM (print your QR card from Settings → Wake Gate)
        </label>
        <div className="btn-row">
          <button className="btn primary lg" onClick={() => void finish(false)}>
            Start with the recommended clock
          </button>
          <button className="btn lg" onClick={() => void finish(true)}>
            Edit my clock first
          </button>
        </div>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          Recommended clock: 7h sleep (9 PM–4 AM) · 5h devotion · 2h protected IIT · 6h founder · 2h meals · 1h care · 1h rest/buffer.
        </p>
      </div>
    </Sheet>
  );
}


