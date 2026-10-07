import { AnimatePresence, motion } from 'motion/react';
import { TriangleAlert, Plus, RotateCcw, Save, Trash } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CATEGORY_META, CATEGORY_ORDER, DEFAULT_BLOCKS } from '../core/defaults';
import { blocksFromTemplate } from '../core/engine';
import type { BlockDef, Category } from '../core/types';
import { fmtClock, fmtDur, offsetFromClock, offsetOf, parseClock, logicalDate } from '../core/time';
import { Dial } from '../components/Dial';
import { EASE, Field, Toggle, catColor } from '../components/ui';
import { resetDayToTemplate, saveTemplate, today, uid, updateSettings } from '../state/actions';
import { useNow } from '../state/runtime';
import { useStore } from '../state/store';

export function Clock() {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const now = useNow();
  const ds = doc.settings.dayStart;
  const [draft, setDraft] = useState<BlockDef[]>(() => doc.template.blocks.map((b) => ({ ...b })));
  const [openId, setOpenId] = useState<string | null>(null);
  const savedSig = JSON.stringify(doc.template.blocks);
  const dirty = JSON.stringify(draft) !== savedSig;

  useEffect(() => {
    if (!dirty) setDraft(doc.template.blocks.map((b) => ({ ...b })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSig]);

  const sorted = useMemo(() => [...draft].sort((a, b) => offsetFromClock(a.start, ds) - offsetFromClock(b.start, ds)), [draft, ds]);
  const planBlocks = useMemo(() => blocksFromTemplate(draft, ds), [draft, ds]);
  const date = logicalDate(now, ds);
  const off = offsetOf(now, date, ds);

  // Allocation + validation
  const totals = useMemo(() => {
    const t = new Map<Category, number>();
    for (const b of draft) t.set(b.category, (t.get(b.category) ?? 0) + b.dur);
    return [...t.entries()].sort((a, b) => CATEGORY_ORDER.indexOf(a[0]) - CATEGORY_ORDER.indexOf(b[0]));
  }, [draft]);
  const total = draft.reduce((a, b) => a + b.dur, 0);
  const issues = useMemo(() => {
    const out: string[] = [];
    const pb = planBlocks;
    for (let i = 0; i < pb.length; i++) {
      const a = pb[i];
      const b = pb[i + 1];
      if (b && a.e > b.s) out.push(`${a.title} overlaps ${b.title} by ${fmtDur(a.e - b.s)}.`);
      if (b && a.e < b.s) out.push(`Unassigned gap of ${fmtDur(b.s - a.e)} after ${a.title}.`);
    }
    if (pb.length && pb[0].s > 0) out.push(`Unassigned gap of ${fmtDur(pb[0].s)} at the start of the day.`);
    const last = pb.at(-1);
    if (last && last.e < 1440) out.push(`Unassigned gap of ${fmtDur(1440 - last.e)} at the end of the day.`);
    const sleep = draft.filter((b) => b.category === 'sleep').reduce((a, b) => a + b.dur, 0);
    if (sleep < 420) out.push(`Sleep is ${fmtDur(sleep)}. Below 7h, every other block gets worse.`);
    if (!draft.some((b) => b.category === 'iit')) out.push('There is no IIT block — study has no protected territory.');
    return out;
  }, [planBlocks, draft]);

  const patch = (id: string, p: Partial<BlockDef>) => setDraft((d) => d.map((b) => (b.id === id ? { ...b, ...p } : b)));

  const save = (applyToday: boolean) => {
    saveTemplate(draft);
    if (applyToday) resetDayToTemplate(today());
    toast(applyToday ? 'Master clock saved and applied to today.' : 'Master clock saved. New days use it from now on.', 'success');
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Master clock</h1>
          <p>The fixed rules of your day. Rescue Mode and the AI work inside these — never against them.</p>
        </div>
        <div className="btn-row">
          <button className="btn ghost" onClick={() => setDraft(DEFAULT_BLOCKS.map((b) => ({ ...b })))}>
            <RotateCcw size={16} /> Recommended
          </button>
          <button className="btn" disabled={!dirty} onClick={() => save(false)}>
            <Save size={16} /> Save
          </button>
          <button className="btn primary" onClick={() => save(true)}>
            Save &amp; apply to today
          </button>
        </div>
      </header>

      <div className="clock-grid">
        <div className="stack lg">
          <section className="card">
            <Dial blocks={planBlocks} dayStart={ds} nowOffset={off} onSelect={(b) => setOpenId(b.origin ?? b.id)} centerTop="24h" centerSub={dirty ? 'unsaved draft' : 'master clock'} />
          </section>
          <section className="card">
            <h2 className="card-title">
              <span>Allocation</span>
              <span className="mono" style={{ color: total === 1440 ? 'var(--ok)' : 'var(--bad)' }}>
                {fmtDur(total)} / 24h
              </span>
            </h2>
            <div className="alloc">
              {totals.map(([c, m]) => (
                <motion.i key={c} layout style={{ background: catColor(c), flexGrow: m }} transition={{ duration: 0.3, ease: EASE }} />
              ))}
            </div>
            <p className="mono" style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 0 }}>
              {totals.map(([c, m], i) => (
                <span key={c}>
                  {i > 0 && ' + '}
                  {fmtDur(m)} {CATEGORY_META[c].short}
                </span>
              ))}{' '}
              = {fmtDur(total)}
            </p>
          </section>
          <section className="card">
            <h2 className="card-title">Day boundary</h2>
            <Field label="A new day starts at" hint="Usually the end of sleep. Blocks after midnight still belong to the previous day.">
              <input
                className="input mono"
                defaultValue={fmtClock(ds, true)}
                key={ds}
                onBlur={(e) => {
                  const v = parseClock(e.target.value);
                  if (v === null) return toast('Use a time like 04:00', 'warn');
                  if (v !== ds) {
                    updateSettings({ dayStart: v });
                    toast(`Days now start at ${fmtClock(v)}.`, 'success');
                  }
                }}
              />
            </Field>
          </section>
        </div>

        <div className="stack">
          <AnimatePresence>
            {issues.length > 0 && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
                <div className="banner" data-tone="drifting">
                  <TriangleAlert size={18} />
                  <div>
                    {issues.map((i) => (
                      <div key={i} style={{ fontSize: 14 }}>
                        {i}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div layout className="stack" style={{ gap: 8 }}>
            {sorted.map((b) => {
              const open = openId === b.id;
              const end = (b.start + b.dur) % 1440;
              return (
                <motion.div layout key={b.id} transition={{ duration: 0.25, ease: EASE }}>
                  <div className="blk-row" data-open={open} onClick={() => setOpenId(open ? null : b.id)}>
                    <span className="bar" style={{ background: catColor(b.category) }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 500 }}>{b.title}</div>
                      <div className="faint" style={{ fontSize: 13 }}>
                        {CATEGORY_META[b.category].label}
                        {b.fixed && ' · fixed anchor'}
                        {b.focus && ' · focus'}
                        {b.minMinutes > 0 && !b.fixed && ` · min ${fmtDur(b.minMinutes)}`}
                      </div>
                    </div>
                    <div className="mono" style={{ textAlign: 'right', fontSize: 13 }}>
                      {fmtClock(b.start)} – {fmtClock(end)}
                      <div className="faint">{fmtDur(b.dur)}</div>
                    </div>
                  </div>
                  <AnimatePresence initial={false}>
                    {open && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: EASE }} style={{ overflow: 'hidden' }}>
                        <BlockEditor block={b} onChange={(p) => patch(b.id, p)} onDelete={() => setDraft((d) => d.filter((x) => x.id !== b.id))} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </motion.div>
          <button
            className="btn"
            onClick={() => {
              const id = uid('b');
              setDraft((d) => [...d, { id, title: 'New block', category: 'founder', start: 12 * 60, dur: 60, fixed: false, focus: true, minMinutes: 0, priority: 3 }]);
              setOpenId(id);
            }}
          >
            <Plus size={16} /> Add block
          </button>
        </div>
      </div>
    </div>
  );
}

function BlockEditor({ block, onChange, onDelete }: { block: BlockDef; onChange: (p: Partial<BlockDef>) => void; onDelete: () => void }) {
  const [start, setStart] = useState(fmtClock(block.start, true));
  const [end, setEnd] = useState(fmtClock((block.start + block.dur) % 1440, true));
  useEffect(() => {
    setStart(fmtClock(block.start, true));
    setEnd(fmtClock((block.start + block.dur) % 1440, true));
  }, [block.start, block.dur]);

  const commitTimes = () => {
    const s = parseClock(start);
    const e = parseClock(end);
    if (s === null || e === null) return;
    const dur = (e - s + 1440) % 1440 || 1440;
    onChange({ start: s, dur });
  };

  return (
    <div className="blk-editor">
      <div className="form-grid">
        <Field label="Title">
          <input className="input" value={block.title} onChange={(e) => onChange({ title: e.target.value })} />
        </Field>
        <Field label="Category">
          <select className="select" value={block.category} onChange={(e) => onChange({ category: e.target.value as Category })}>
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_META[c].label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Starts">
          <input className="input mono" value={start} onChange={(e) => setStart(e.target.value)} onBlur={commitTimes} />
        </Field>
        <Field label="Ends">
          <input className="input mono" value={end} onChange={(e) => setEnd(e.target.value)} onBlur={commitTimes} />
        </Field>
      </div>
      <div className="form-grid">
        <Field label="Rescue minimum" hint="How far Rescue Mode may shrink it">
          <select className="select" value={block.minMinutes} onChange={(e) => onChange({ minMinutes: Number(e.target.value) })}>
            {[0, 10, 15, 30, 45, 60, 90, 120, 180, 240, 420].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'Can be dropped' : fmtDur(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" hint="1 is protected first">
          <select className="select" value={block.priority} onChange={(e) => onChange({ priority: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {p}
                {p === 1 ? ' — protect' : p === 5 ? ' — drop first' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row between wrap">
        <label className="row">
          <Toggle on={block.fixed} onChange={(v) => onChange({ fixed: v })} label="Fixed anchor" />
          <span style={{ fontSize: 14 }}>Fixed anchor (never moved)</span>
        </label>
        <label className="row">
          <Toggle on={block.focus} onChange={(v) => onChange({ focus: v })} label="Focus block" />
          <span style={{ fontSize: 14 }}>Focus block (mission + Focus Guard)</span>
        </label>
        <button className="btn ghost sm danger" onClick={onDelete}>
          <Trash size={14} /> Delete
        </button>
      </div>
    </div>
  );
}
