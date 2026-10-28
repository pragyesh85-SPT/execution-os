import { Maximize2, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NODE_H, NODE_W, type ConceptGraph } from '../core/study/graph';
import { RUNG_LABEL, type Rung } from '../core/study/types';
import { studyCall } from '../lib/studyApi';

// The concept graph of one subject, drawn: arrows from prerequisites, dashed lines to the questions that
// test a concept, dotted red lines between concepts that are often confused. Colour = ladder rung.
// Wheel / pinch / buttons zoom, drag pans, a tap on a concept opens it.

const RUNG_COLOR: Record<Rung, string> = {
  none: 'var(--surface-3)',
  seen: '#8A9AD0',
  understood: '#5CA8EC',
  applied: '#5FC08A',
  retained: '#2C8C88',
  exam_ready: 'var(--accent)',
};

export function StudyGraph({ subjects, onOpen }: { subjects: { subject: string; title: string }[]; onOpen: (concept: string) => void }) {
  const [subject, setSubject] = useState(subjects[0]?.subject ?? '');
  const [g, setG] = useState<ConceptGraph | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const box = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);

  const fit = useCallback((graph: ConceptGraph) => {
    const w = box.current?.clientWidth ?? 800;
    const k = Math.min(1.2, Math.max(0.25, (w - 16) / graph.width, 420 / graph.height));
    setView({ x: 8, y: 8, k });
  }, []);
  useEffect(() => {
    if (!subject) return;
    setErr('');
    studyCall<ConceptGraph>('graph', { subject }).then(
      (r) => {
        setG(r);
        fit(r);
      },
      (e: Error) => setErr(e.message),
    );
  }, [subject, fit]);

  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(3, Math.max(0.2, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const byId = new Map((g?.nodes ?? []).map((n) => [n.id, n]));
  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
          {subjects.map((s) => (
            <option key={s.subject} value={s.subject}>
              {s.title}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button className="btn ghost sm icon" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25, 200, 150)}>
          <Minus size={14} />
        </button>
        <button className="btn ghost sm icon" aria-label="Zoom in" onClick={() => zoomAt(1.25, 200, 150)}>
          <Plus size={14} />
        </button>
        <button className="btn ghost sm icon" aria-label="Fit" onClick={() => g && fit(g)}>
          <Maximize2 size={14} />
        </button>
      </div>
      {err && <p className="faint">{err}</p>}
      <div
        ref={box}
        style={{ position: 'relative', height: 460, borderRadius: 10, border: '1px solid var(--line)', overflow: 'hidden', touchAction: 'none', cursor: 'grab', background: 'var(--surface-2)' }}
        onWheel={(e) => {
          const p = local(e);
          zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
        }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          pointers.current.set(e.pointerId, local(e));
          moved.current = false;
        }}
        onPointerMove={(e) => {
          const prev = pointers.current.get(e.pointerId);
          if (!prev) return;
          const cur = local(e);
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            const other = a === prev ? b : a;
            const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
            const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
            if (d0 > 0) zoomAt(d1 / d0, (cur.x + other.x) / 2, (cur.y + other.y) / 2);
          } else {
            setView((v) => ({ ...v, x: v.x + cur.x - prev.x, y: v.y + cur.y - prev.y }));
          }
          if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 2) moved.current = true;
          pointers.current.set(e.pointerId, cur);
        }}
        onPointerUp={(e) => pointers.current.delete(e.pointerId)}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
      >
        {g && (
          <svg width="100%" height="100%" role="img" aria-label={`Concept graph of ${subject}`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--ink-3)" />
              </marker>
            </defs>
            <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
              {g.edges.map((e, i) => {
                const a = byId.get(e.from)!;
                const b = byId.get(e.to)!;
                const x1 = a.x + NODE_W;
                const y1 = a.y + NODE_H / 2;
                const x2 = b.x;
                const y2 = b.y + NODE_H / 2;
                const same = a.col === b.col;
                const d = same ? `M${a.x + NODE_W / 2},${a.y + NODE_H} C${a.x + NODE_W + 60},${(a.y + b.y) / 2 + NODE_H} ${b.x + NODE_W + 60},${(a.y + b.y) / 2} ${b.x + NODE_W / 2},${b.y}` : `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`;
                const style = e.kind === 'prereq' ? { stroke: 'var(--ink-3)', dash: undefined } : e.kind === 'tested' ? { stroke: 'var(--ink-3)', dash: '6 5' } : { stroke: 'var(--bad)', dash: '2 4' };
                return <path key={i} d={d} fill="none" stroke={style.stroke} strokeWidth={1.6} strokeDasharray={style.dash} markerEnd={e.kind === 'prereq' ? 'url(#arrow)' : undefined} opacity={0.8} />;
              })}
              {g.nodes.map((n) => (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: n.kind === 'concept' ? 'pointer' : 'default' }}
                  onClick={() => !moved.current && n.kind === 'concept' && onOpen(n.id)}
                >
                  <title>{n.kind === 'concept' ? `${n.title} — ${RUNG_LABEL[n.rung ?? 'none']}` : `Question ${n.id}`}</title>
                  <rect width={NODE_W} height={NODE_H} rx={10} fill={n.kind === 'concept' ? RUNG_COLOR[n.rung ?? 'none'] : 'var(--surface)'} stroke="var(--line-strong)" strokeDasharray={n.kind === 'question' ? '4 3' : undefined} />
                  <text x={10} y={21} fontSize={13} fontWeight={600} fill={n.kind === 'concept' && n.rung !== 'none' ? '#111' : 'var(--ink)'}>
                    {n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title}
                  </text>
                  <text x={10} y={39} fontSize={11} fill={n.kind === 'concept' && n.rung !== 'none' ? '#222' : 'var(--ink-3)'}>
                    {n.kind === 'concept' ? RUNG_LABEL[n.rung ?? 'none'] : 'question'}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
      <p className="faint" style={{ margin: '6px 0 0', fontSize: 12 }}>
        → prerequisite · - - tested by · ··· often confused (red) · colour = level: grey not started, blue seen/understood, green applied, teal retained, orange exam-ready
      </p>
    </div>
  );
}
