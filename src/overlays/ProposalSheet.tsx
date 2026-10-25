import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, CircleMinus, CirclePlus, Inbox, Lock, RefreshCw, Scissors, Sparkles, Split, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { liveBlocks, planFor } from '../core/engine';
import { isStale, pendingProposals } from '../core/proposals';
import type { Proposal, ProposedLine } from '../core/types';
import { longDate } from '../core/time';
import { EASE, Sheet } from '../components/ui';
import { applyProposal, attempt, rebaseProposal, rejectProposal } from '../state/actions';
import { useFlag } from '../state/hooks';
import { useStore } from '../state/store';
import { successTone } from '../lib/sound';
import { TimelineBar } from './RescueV2';

// Review sheet for pending proposals (Rescue, AI plans, imports). Shows a before/after per day
// and the reason for every change. A proposal made against an older plan is re-checked first.

const ICON: Record<ProposedLine['kind'], ReactNode> = {
  kept: <Lock size={14} />,
  moved: <ArrowRight size={14} />,
  shortened: <Scissors size={14} />,
  split: <Split size={14} />,
  dropped: <CircleMinus size={14} />,
  added: <CirclePlus size={14} />,
};

export function proposalHeadline(p: Proposal): string {
  if (p.kind === 'rescue') return `${p.source === 'mcp' ? 'Rescue plan from ' + (p.client ?? 'AI') : 'Rescue plan'} ready`;
  if (p.kind === 'import') return `${p.title}`;
  const who = p.source === 'mcp' ? `from ${p.client ? p.client[0].toUpperCase() + p.client.slice(1) : 'AI'}` : '';
  return `New ${p.kind === 'week_plan' ? 'week plan' : 'plan'} ${who}`.trim();
}

export function ProposalBanner() {
  const on = useFlag('proposals');
  const doc = useStore((s) => s.doc);
  const open = useStore((s) => s.open);
  if (!on) return null;
  const list = pendingProposals(doc);
  if (!list.length) return null;
  const p = list[0];
  return (
    <div className="banner" data-tone="info">
      <Sparkles size={18} />
      <div className="grow">
        <h3>
          {proposalHeadline(p)}
          {list.length > 1 ? ` · ${list.length} waiting` : ''}
        </h3>
        <p>{p.rationale ?? p.title}. Nothing changes until you apply it.</p>
        <button className="btn primary sm" onClick={() => open({ proposals: true })}>
          Review
        </button>
      </div>
    </div>
  );
}

export function ProposalSheet() {
  const show = useStore((s) => !!s.overlay.proposals);
  const open = useStore((s) => s.open);
  const doc = useStore((s) => s.doc);
  const list = pendingProposals(doc);
  return (
    <Sheet open={show} wide onClose={() => open({ proposals: false })} title="Proposed changes" subtitle="Review before anything changes. Pins and anchors are never moved.">
      {list.length === 0 ? (
        <div className="empty">
          <strong>Nothing waiting.</strong>
          <span>Rescue plans and AI plans you save for review appear here.</span>
        </div>
      ) : (
        <div className="stack lg">
          <AnimatePresence initial={false}>
            {list.map((p) => (
              <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22, ease: EASE }}>
                <ProposalCard p={p} onDone={() => list.length <= 1 && open({ proposals: false })} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Sheet>
  );
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const doc = useStore((s) => s.doc);
  const toast = useStore((s) => s.toast);
  const ds = doc.settings.dayStart;
  const stale = isStale(doc, p);
  const canWeek = p.scopeAllowed.includes('week') && p.days.length > 1;
  const decide = (scope: 'today' | 'week') => {
    if (attempt(() => applyProposal(p.id, scope))) {
      successTone();
      toast(scope === 'week' ? 'Applied for the week.' : 'Applied.', 'success');
      onDone();
    }
  };
  return (
    <section className="card flat proposal-card">
      <div className="row between wrap" style={{ alignItems: 'start' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16 }}>{p.title}</h3>
          {p.rationale && <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>{p.rationale}</p>}
        </div>
        <span className="chip">{p.source === 'mcp' ? (p.client ?? 'AI') : p.source === 'automation' ? 'automation' : 'Execution OS'}</span>
      </div>

      {stale && (
        <div className="banner" data-tone="drifting" style={{ margin: '12px 0 0' }}>
          <RefreshCw size={18} />
          <div className="grow">
            <h3>Your plan changed since this was made</h3>
            <p>It will be re-checked against your latest plan — nothing you changed is overwritten.</p>
            <button
              className="btn primary sm"
              onClick={() => {
                if (attempt(() => void rebaseProposal(p.id))) toast('Re-checked. Review the updated proposal.', 'info');
              }}
            >
              Re-check now
            </button>
          </div>
        </div>
      )}

      {p.days.map((day) => {
        const span = 1440;
        const before = liveBlocks(planFor(doc, day.date));
        const after = day.blocks.filter((b) => !b.missed);
        return (
          <div key={day.date} className="stack" style={{ gap: 6, marginTop: 14 }}>
            <strong style={{ fontSize: 14 }}>{longDate(day.date)}</strong>
            {day.blocks.length > 0 && (
              <>
                <TimelineBar label="Now" blocks={before} from={0} span={span} ds={ds} />
                <TimelineBar label="After" blocks={after} from={0} span={span} ds={ds} />
              </>
            )}
            {day.outcomes?.length ? <div className="faint" style={{ fontSize: 13 }}>Outcomes: {day.outcomes.map((o) => o.text).join(' · ')}</div> : null}
            <ul className="rescue-lines">
              {day.lines.map((l, i) => (
                <li key={`${l.blockId}-${i}`} data-kind={l.kind}>
                  <span className="ic">{ICON[l.kind]}</span>
                  <span>{l.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {(p.warnings?.length ?? 0) > 0 && (
        <div className="stack" style={{ gap: 4, marginTop: 12 }}>
          {p.warnings!.map((w) => (
            <span key={w} className="row" style={{ gap: 6, fontSize: 13, color: 'var(--warn)' }}>
              <TriangleAlert size={14} /> {w}
            </span>
          ))}
        </div>
      )}
      {(p.tasksToAdd?.length ?? 0) > 0 && (
        <div className="row" style={{ gap: 6, fontSize: 13, marginTop: 12 }}>
          <Inbox size={14} /> To the task inbox: {p.tasksToAdd!.map((t) => `“${t.title}”`).join(', ')}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button
          className="btn ghost"
          onClick={() => {
            if (attempt(() => rejectProposal(p.id))) {
              toast('Rejected. Nothing changed.', 'info');
              onDone();
            }
          }}
        >
          Reject
        </button>
        {!stale && canWeek && (
          <button className="btn" onClick={() => decide('week')}>
            Apply for the week
          </button>
        )}
        {!stale && p.scopeAllowed.includes('today') && (
          <button className="btn primary" onClick={() => decide('today')}>
            Apply {p.days.length > 1 ? 'for today' : ''}
          </button>
        )}
        {!stale && !p.scopeAllowed.includes('today') && (
          <button className="btn primary" onClick={() => decide('week')}>
            Apply
          </button>
        )}
      </div>
      <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
        Expires {new Date(p.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.
      </p>
    </section>
  );
}
