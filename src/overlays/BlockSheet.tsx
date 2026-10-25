import { AnimatePresence } from 'motion/react';
import { Flag, Lock, Pin, PinOff, Video } from 'lucide-react';
import { openJoin } from '../lib/join';
import { useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { missionFor, planFor } from '../core/engine';
import { isAnchor } from '../core/ops';
import { clockOf, fmtClock, fmtDur, offsetFromClock, offsetOf, parseClock } from '../core/time';
import { Field, Sheet, catColor } from '../components/ui';
import { attempt, moveDayBlock, pinBlock, setMission } from '../state/actions';
import { useFlag } from '../state/hooks';
import { useNow } from '../state/runtime';
import { useStore } from '../state/store';

// Block detail: pin / unpin, edit the time of a flexible block, set its mission.
// Opened by long-press (phone) or right-click (desktop) on any block row, or by tapping it.

export function BlockSheet() {
  const target = useStore((s) => s.overlay.block);
  const open = useStore((s) => s.open);
  return (
    <AnimatePresence>
      {target && <BlockInner key={`${target.date}:${target.blockId}`} date={target.date} blockId={target.blockId} onClose={() => open({ block: undefined })} />}
    </AnimatePresence>
  );
}

function BlockInner({ date, blockId, onClose }: { date: string; blockId: string; onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const open = useStore((s) => s.open);
  const setTab = useStore((s) => s.setTab);
  const pins = useFlag('pins');
  const now = useNow();
  const ds = doc.settings.dayStart;
  const plan = planFor(doc, date);
  const block = plan.blocks.find((b) => b.id === blockId);
  const mission = block ? missionFor(plan, block) : undefined;
  const [start, setStart] = useState(() => (block ? fmtClock(clockOf(block.s, ds), true) : ''));
  const [dur, setDur] = useState(() => (block ? block.e - block.s : 60));
  const [title, setTitle] = useState(mission?.title ?? '');
  if (!block) return null;

  const anchor = isAnchor(doc, block);
  const flexible = !block.fixed;
  const pinnable = pins && !anchor && !block.exception && block.category !== 'buffer' && !block.missed;
  const missionKey = plan.missions[block.id] ? block.id : block.origin && plan.missions[block.origin] ? block.origin : block.id;
  const offNow = offsetOf(now, date, ds);
  const finished = block.e <= offNow;
  const durations = [...new Set([15, 30, 45, 60, 90, 120, 150, 180, 240, 300, block.e - block.s])].sort((a, b) => a - b);

  const saveTime = () => {
    const clock = parseClock(start);
    if (clock === null) return toast('Use a time like 16:00 or 4:00 pm.', 'warn');
    const s = offsetFromClock(clock, ds);
    const e = Math.min(1440, s + dur);
    if (s % 5 || e % 5) return toast('Use 5-minute steps, e.g. 16:05.', 'warn');
    if (!attempt(() => moveDayBlock(date, block.id, s, e))) return;
    const label = fmtClock(clock);
    if (pins) toast(`Moved. Pin this to ${label}?`, 'info', { label: 'Pin', run: () => attempt(() => pinBlock(date, block.id, true)) });
    else toast('Moved.', 'success');
    onClose();
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        <span className="row" style={{ gap: 8 }}>
          <span className="dot" style={{ background: catColor(block.category) }} />
          {block.title}
        </span>
      }
      subtitle={
        <>
          {fmtClock(clockOf(block.s, ds))}–{fmtClock(clockOf(block.e, ds))} · {fmtDur(block.e - block.s)} · {CATEGORY_META[block.category].label}
          {block.pinned ? ' · pinned' : anchor ? ' · anchor' : block.exception ? ' · planned' : ''}
        </>
      }
    >
      <div className="stack lg">
        {block.joinUrl && (
          <div className="row between wrap">
            <span className="faint" style={{ fontSize: 13 }}>
              Class link · {block.joinUrl ? new URL(block.joinUrl).hostname : ''}
              {block.reminderMin ? ` · reminder ${block.reminderMin} min before` : ''}
            </span>
            <button className="btn primary" onClick={() => openJoin(block.joinUrl!)}>
              <Video size={16} /> Join
            </button>
          </div>
        )}
        {anchor && (
          <div className="banner" data-tone="info" style={{ margin: 0 }}>
            <Lock size={18} />
            <div className="grow">
              <h3>Anchor — edit in Clock</h3>
              <p>Anchors like sleep and aarti come from your master clock. Rescue and AI never move them.</p>
              <button
                className="btn sm"
                onClick={() => {
                  onClose();
                  setTab('clock');
                }}
              >
                Open Clock
              </button>
            </div>
          </div>
        )}

        {pinnable && (
          <div className="row between wrap">
            <div>
              <strong>{block.pinned ? 'Pinned to this time' : 'Flexible'}</strong>
              <div className="faint" style={{ fontSize: 13 }}>
                {block.pinned ? 'Rescue rebuilds everything else around it.' : 'Rescue may move or shorten it when the day breaks.'}
              </div>
            </div>
            <button
              className={`btn${block.pinned ? '' : ' primary'}`}
              onClick={() => {
                if (attempt(() => pinBlock(date, block.id, !block.pinned))) toast(block.pinned ? 'Unpinned.' : 'Pinned — Rescue will build around it.', 'success');
              }}
            >
              {block.pinned ? <PinOff size={16} /> : <Pin size={16} />} {block.pinned ? 'Unpin' : 'Pin to this time'}
            </button>
          </div>
        )}

        {flexible && !block.missed && (
          <div className="stack">
            <strong>Edit time</strong>
            <div className="form-grid">
              <Field label="Starts at">
                <input className="input mono" value={start} onChange={(e) => setStart(e.target.value)} placeholder="16:00" />
              </Field>
              <Field label="Duration">
                <select className="select" value={dur} onChange={(e) => setDur(Number(e.target.value))}>
                  {durations.map((m) => (
                    <option key={m} value={m}>
                      {fmtDur(m)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div>
              <button className="btn" onClick={saveTime}>
                Move block
              </button>
            </div>
          </div>
        )}

        {block.focus && !block.missed && (
          <div className="stack">
            <strong>Mission</strong>
            <div className="row">
              <input className="input grow" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The one outcome for this block" />
              <button
                className="btn"
                onClick={() => {
                  setMission(date, missionKey, title.trim() ? { ...(mission ?? { steps: [] }), title: title.trim(), source: mission?.source ?? 'manual' } : null);
                  toast(title.trim() ? 'Mission set.' : 'Mission cleared.', 'success');
                }}
              >
                Save
              </button>
            </div>
          </div>
        )}

        {block.focus && finished && !block.missed && (
          <div>
            <button
              className="btn"
              onClick={() => {
                onClose();
                open({ proof: { date, blockId: block.id } });
              }}
            >
              <Flag size={14} /> Record proof
            </button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
