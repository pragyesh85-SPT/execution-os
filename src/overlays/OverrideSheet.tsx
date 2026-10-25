import { ArrowLeftRight, Hourglass, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { OverrideChoice } from '../core/override';
import { planFor } from '../core/engine';
import { Field, Sheet } from '../components/ui';
import { applyOverrideWithUndo } from '../state/actions';
import { useStore } from '../state/store';

// "I'm doing something else": swap the mission, borrow 15/30 minutes, or log it honestly as drift.

export function OverrideSheet() {
  const target = useStore((s) => s.overlay.override);
  const open = useStore((s) => s.open);
  if (!target) return null;
  return <OverrideInner key={`${target.date}:${target.blockId}`} {...target} onClose={() => open({ override: undefined })} />;
}

function OverrideInner({ date, blockId, what: initial, onClose }: { date: string; blockId: string; what?: string; onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [what, setWhat] = useState(initial ?? '');
  const [driftMin, setDriftMin] = useState(15);
  const [confirmPin, setConfirmPin] = useState<OverrideChoice | null>(null);
  const block = planFor(doc, date).blocks.find((b) => b.id === blockId);
  if (!block) return null;

  const go = (choice: OverrideChoice) => {
    if (block.pinned && !confirmPin && choice.kind !== 'drift') {
      setConfirmPin(choice); // pinned blocks ask once more
      return;
    }
    const msg = choice.kind === 'swap' ? 'Swapped. The old mission is back in your inbox.' : choice.kind === 'borrow' ? `Borrowed ${choice.minutes} minutes. The block still ends on time.` : 'Logged as drift. Honest beats flattering.';
    if (applyOverrideWithUndo(date, blockId, choice, msg)) onClose();
  };

  return (
    <Sheet open onClose={onClose} title="I’m doing something else" subtitle={`${block.title}${block.pinned ? ' · pinned' : ''}`}>
      <div className="stack lg">
        <Field label="What are you doing instead?">
          <input className="input" autoFocus value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Investor follow-up emails" />
        </Field>
        {confirmPin ? (
          <div className="banner" data-tone="drifting" style={{ margin: 0 }}>
            <TriangleAlert size={18} />
            <div className="grow">
              <h3>This block is pinned</h3>
              <p>You pinned it so nothing would move it. Change it anyway?</p>
              <div className="btn-row">
                <button className="btn primary sm" onClick={() => go(confirmPin)}>
                  Yes, change it
                </button>
                <button className="btn ghost sm" onClick={() => setConfirmPin(null)}>
                  Keep the plan
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="stack">
            <button className="override-choice" disabled={!what.trim()} onClick={() => go({ kind: 'swap', what })}>
              <ArrowLeftRight size={18} />
              <span>
                <strong>Swap</strong>
                <span className="faint">This block’s mission becomes “{what.trim() || '…'}”. The old mission goes back to the inbox. Counts as intentional.</span>
              </span>
            </button>
            <div className="row" style={{ gap: 8 }}>
              <button className="override-choice grow" disabled={!what.trim()} onClick={() => go({ kind: 'borrow', what, minutes: 15 })}>
                <Hourglass size={18} />
                <span>
                  <strong>Borrow 15 min</strong>
                  <span className="faint">A short detour; the block keeps its end time.</span>
                </span>
              </button>
              <button className="override-choice grow" disabled={!what.trim()} onClick={() => go({ kind: 'borrow', what, minutes: 30 })}>
                <Hourglass size={18} />
                <span>
                  <strong>Borrow 30 min</strong>
                  <span className="faint">Same, a bit longer.</span>
                </span>
              </button>
            </div>
            <div className="row" style={{ gap: 8, alignItems: 'stretch' }}>
              <button className="override-choice grow" disabled={!what.trim()} onClick={() => go({ kind: 'drift', what, minutes: driftMin })}>
                <TriangleAlert size={18} />
                <span>
                  <strong>Mark as drift</strong>
                  <span className="faint">An honest log. It counts toward unplanned distraction.</span>
                </span>
              </button>
              <select className="select mono" style={{ width: 120 }} value={driftMin} onChange={(e) => setDriftMin(Number(e.target.value))} aria-label="Drift minutes">
                {[10, 15, 30, 45, 60, 90].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
        {!what.trim() && <p className="faint" style={{ margin: 0, fontSize: 13 }}>Type what you are doing first.</p>}
      </div>
    </Sheet>
  );
}
