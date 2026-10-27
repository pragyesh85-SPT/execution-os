import type { BankQuestion, Concept, Rung } from './types';

// The concept graph of one subject, laid out for drawing: concepts in columns by prerequisite depth
// (a concept sits one column right of its deepest prerequisite), in syllabus order inside a column;
// question nodes in a last column. Edges: prerequisite, tested-by, confused-with. Pure and deterministic.

export interface GraphNode {
  id: string;
  title: string;
  kind: 'concept' | 'question';
  rung: Rung | null; // concepts only
  x: number;
  y: number;
  col: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'prereq' | 'tested' | 'confused';
}

export interface ConceptGraph {
  subject: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export const COL_W = 250;
export const ROW_H = 78;
export const NODE_W = 200;
export const NODE_H = 52;
const PAD = 30;

export function layoutGraph(subject: string, concepts: Concept[], rung: (id: string) => Rung, questions: BankQuestion[]): ConceptGraph {
  const cs = concepts.filter((c) => c.subject === subject && !c.mergedInto).sort((a, b) => (a.week ?? 999) - (b.week ?? 999) || a.order - b.order);
  const ids = new Set(cs.map((c) => c.id));
  const byId = new Map(cs.map((c) => [c.id, c]));
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const d = (id: string): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0; // a cycle: break it here (the week-end check reports it)
    visiting.add(id);
    const pre = byId.get(id)!.prereqs.filter((p) => ids.has(p));
    const v = pre.length ? 1 + Math.max(...pre.map(d)) : 0;
    visiting.delete(id);
    depth.set(id, v);
    return v;
  };
  for (const c of cs) d(c.id);

  const cols = new Map<number, Concept[]>();
  for (const c of cs) (cols.get(depth.get(c.id)!) ?? cols.set(depth.get(c.id)!, []).get(depth.get(c.id)!)!).push(c);
  const nodes: GraphNode[] = [];
  for (const [col, list] of [...cols].sort((a, b) => a[0] - b[0])) {
    list.forEach((c, i) => nodes.push({ id: c.id, title: c.title, kind: 'concept', rung: rung(c.id), col, x: PAD + col * COL_W, y: PAD + i * ROW_H }));
  }
  const edges: GraphEdge[] = [];
  for (const c of cs) {
    for (const p of c.prereqs) if (ids.has(p) && p !== c.id) edges.push({ from: p, to: c.id, kind: 'prereq' });
    for (const o of c.confusedWith) if (ids.has(o) && o > c.id) edges.push({ from: c.id, to: o, kind: 'confused' });
  }

  // questions that test these concepts (bank questions, and ids a card lists in testedBy)
  const qcol = (cols.size ? Math.max(...cols.keys()) : -1) + 1;
  const qs = questions.filter((q) => q.subject === subject && q.concepts.some((c) => ids.has(c)));
  const listed = new Set(cs.flatMap((c) => c.testedBy));
  const shown = [...new Map(qs.map((q) => [q.id, q])).values()];
  shown.forEach((q, i) => {
    nodes.push({ id: q.id, title: q.id, kind: 'question', rung: null, col: qcol, x: PAD + qcol * COL_W, y: PAD + i * ROW_H });
    for (const c of q.concepts) if (ids.has(c)) edges.push({ from: c, to: q.id, kind: 'tested' });
  });
  for (const c of cs) for (const t of c.testedBy) if (!shown.some((q) => q.id === t) && listed.has(t)) edges.push({ from: c.id, to: t, kind: 'tested' });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const keptEdges = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  const width = PAD * 2 + Math.max(0, ...nodes.map((n) => n.x - PAD)) + NODE_W;
  const height = PAD * 2 + Math.max(0, ...nodes.map((n) => n.y - PAD)) + NODE_H;
  return { subject, nodes, edges: keptEdges, width, height };
}
