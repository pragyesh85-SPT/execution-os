import { AnimatePresence, motion } from 'motion/react';
import { Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import { CATEGORY_META, CATEGORY_ORDER } from '../core/defaults';
import type { Category, Rule, RuleAction, RuleTrigger } from '../core/types';
import { fmtClock, parseClock } from '../core/time';
import { EASE, Field, Sheet, Toggle } from '../components/ui';
import { deleteRule, saveRule, uid } from '../state/actions';
import { useStore } from '../state/store';

// Implementation intentions (Gollwitzer & Sheeran): decide in advance
// "when situation X happens, I do Y" — the decision is made before the moment of weakness.

type TriggerType = RuleTrigger['type'];
type ActionType = RuleAction['type'];

const TRIGGERS: { value: TriggerType; label: string }[] = [
  { value: 'block_start', label: 'a block starts' },
  { value: 'block_missed', label: 'I have not started a block for N minutes' },
  { value: 'outcomes_done', label: 'I complete all 3 outcomes' },
  { value: 'time', label: 'it becomes a specific time' },
  { value: 'urge', label: 'I feel an urge during focus' },
];

const ACTIONS: { value: ActionType; label: string }[] = [
  { value: 'focus', label: 'open Focus Mode with the mission' },
  { value: 'rescue', label: 'open Rescue Mode' },
  { value: 'notify', label: 'remind me with a message' },
  { value: 'unlock_ent', label: 'unlock optional entertainment' },
  { value: 'save_later', label: 'save it to Later instead' },
];

export function describeTrigger(t: RuleTrigger): string {
  switch (t.type) {
    case 'block_start':
      return `the ${CATEGORY_META[t.category].short} block starts`;
    case 'block_missed':
      return `I miss more than ${t.minutes} minutes of a ${CATEGORY_META[t.category].short} block`;
    case 'outcomes_done':
      return 'I complete the day’s three outcomes';
    case 'time':
      return `it becomes ${fmtClock(t.at)}`;
    case 'urge':
      return 'I feel like opening something distracting during focus';
  }
}

export function describeAction(a: RuleAction): string {
  switch (a.type) {
    case 'focus':
      return 'open the mission and turn Focus Guard on';
    case 'rescue':
      return 'activate Rescue Mode';
    case 'notify':
      return `remind me: “${a.message}”`;
    case 'unlock_ent':
      return 'optional entertainment becomes available';
    case 'save_later':
      return 'save it to Later instead of opening it';
  }
}

export function Rules() {
  const doc = useStore((s) => s.doc);
  const [editing, setEditing] = useState<Rule | null>(null);
  const rules = Object.values(doc.rules)
    .filter((r) => !r.del)
    .sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>IF → THEN rules</h1>
          <p>Decide in advance what happens in the moment. Rules run on every device, every second.</p>
        </div>
        <button
          className="btn primary"
          onClick={() =>
            setEditing({
              id: uid('r'),
              u: 0,
              enabled: true,
              trigger: { type: 'block_start', category: 'iit' },
              action: { type: 'focus' },
              cue: '',
              createdAt: Date.now(),
            })
          }
        >
          <Plus size={16} /> New rule
        </button>
      </header>

      <motion.div layout className="stack">
        <AnimatePresence initial={false}>
          {rules.map((r) => (
            <motion.div
              layout
              key={r.id}
              className="rule"
              data-on={r.enabled}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.22, ease: EASE }}
            >
              <button style={{ all: 'unset', cursor: 'pointer' }} onClick={() => setEditing(r)}>
                <div className="rule-sentence">
                  <b>IF</b> {describeTrigger(r.trigger)} <b>THEN</b> {describeAction(r.action)}
                </div>
                {r.cue && r.cue !== autoCue(r) && (
                  <div className="faint" style={{ fontSize: 13, marginTop: 4 }}>
                    {r.cue}
                  </div>
                )}
              </button>
              <div className="row">
                <Toggle on={r.enabled} onChange={(v) => saveRule({ ...r, enabled: v })} label="Rule enabled" />
                <button className="btn ghost icon sm" aria-label="Delete rule" onClick={() => deleteRule(r.id)}>
                  <Trash size={14} />
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {rules.length === 0 && (
          <div className="empty">
            <strong>No rules yet.</strong>
            <span>Start with: IF the IIT block starts THEN open Focus Mode.</span>
          </div>
        )}
      </motion.div>

      <section className="card flat" style={{ marginTop: 24 }}>
        <h2 className="card-title">Why rules beat willpower</h2>
        <p style={{ margin: 0 }} className="muted">
          A meta-analysis of 94 studies (Gollwitzer &amp; Sheeran, 2006) found a medium-to-large effect on goal achievement when people decide
          in advance <em>when X happens, I do Y</em>. The decision is made calmly now, so the moment itself needs no decision.
        </p>
      </section>

      {editing && <RuleEditor key={editing.id} rule={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function autoCue(r: Pick<Rule, 'trigger' | 'action'>) {
  return `IF ${describeTrigger(r.trigger)} THEN ${describeAction(r.action)}.`;
}

function RuleEditor({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const [trigger, setTrigger] = useState<RuleTrigger>(rule.trigger);
  const [action, setAction] = useState<RuleAction>(rule.action);
  const [cue, setCue] = useState(rule.cue);
  const [timeText, setTimeText] = useState(trigger.type === 'time' ? fmtClock(trigger.at, true) : '10:00');
  const category: Category = 'category' in trigger ? trigger.category : 'iit';

  const setTriggerType = (type: TriggerType) => {
    if (type === 'block_start') setTrigger({ type, category });
    else if (type === 'block_missed') setTrigger({ type, category, minutes: 20 });
    else if (type === 'time') setTrigger({ type, at: parseClock(timeText) ?? 600 });
    else setTrigger({ type } as RuleTrigger);
  };
  const setActionType = (type: ActionType) => {
    if (type === 'notify') setAction({ type, message: action.type === 'notify' ? action.message : 'Phone face down. One mission.' });
    else setAction({ type } as RuleAction);
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={rule.u ? 'Edit rule' : 'New rule'}
      subtitle="Pick the situation and the automatic response."
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              saveRule({ ...rule, trigger, action, cue: cue.trim() || autoCue({ trigger, action }) });
              onClose();
            }}
          >
            Save rule
          </button>
        </>
      }
    >
      <div className="stack lg">
        <div className="rule-sentence" style={{ padding: 12, borderRadius: 10, background: 'var(--surface-2)' }}>
          <b>IF</b> {describeTrigger(trigger)} <b>THEN</b> {describeAction(action)}
        </div>
        <div className="form-grid">
          <Field label="IF">
            <select className="select" value={trigger.type} onChange={(e) => setTriggerType(e.target.value as TriggerType)}>
              {TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          {(trigger.type === 'block_start' || trigger.type === 'block_missed') && (
            <Field label="Block category">
              <select className="select" value={trigger.category} onChange={(e) => setTrigger({ ...trigger, category: e.target.value as Category })}>
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_META[c].label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {trigger.type === 'block_missed' && (
            <Field label="Minutes late">
              <input className="input mono" inputMode="numeric" value={trigger.minutes} onChange={(e) => setTrigger({ ...trigger, minutes: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </Field>
          )}
          {trigger.type === 'time' && (
            <Field label="Time">
              <input
                className="input mono"
                value={timeText}
                onChange={(e) => {
                  setTimeText(e.target.value);
                  const v = parseClock(e.target.value);
                  if (v !== null) setTrigger({ type: 'time', at: v });
                }}
              />
            </Field>
          )}
        </div>
        <div className="form-grid">
          <Field label="THEN">
            <select className="select" value={action.type} onChange={(e) => setActionType(e.target.value as ActionType)}>
              {ACTIONS.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
          {action.type === 'notify' && (
            <Field label="Message">
              <input className="input" value={action.message} onChange={(e) => setAction({ type: 'notify', message: e.target.value })} />
            </Field>
          )}
        </div>
        <Field label="Your own words (optional)" hint="Shown under the rule — write it the way you would say it to yourself.">
          <input className="input" value={cue} onChange={(e) => setCue(e.target.value)} placeholder={autoCue({ trigger, action })} />
        </Field>
      </div>
    </Sheet>
  );
}
