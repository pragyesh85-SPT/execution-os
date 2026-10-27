import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ID_RE } from '../../src/core/study/ids';
import type { Segment } from '../../src/core/study/types';
import { StudyError } from './errors';
import { parsePath } from './parse';
import type { StudyService } from './service';
import { inVault, rel } from './vault';
import { dumpYaml, frontMatter, withFrontMatter } from './yaml';

// Changes to the learning graph or a resource path proposed from outside the PC (Claude mobile through
// MCP) never apply directly: they wait as a proposal until you apply them in the Study tab. Applying
// writes the vault file and keeps the previous content in the audit table, so Undo puts it back —
// unless the file changed again since (then Undo explains instead of overwriting).

export type ProposalKind = 'path' | 'graph';

export interface PathChange {
  concept: string;
  segments: Partial<Segment>[];
  alternates?: Partial<Segment>[];
}

export interface GraphChange {
  concept: string;
  prereqs?: string[];
  confusedWith?: string[];
  mergedInto?: string | null;
}

export interface StudyProposal {
  id: string;
  at: number;
  client: string | null;
  kind: ProposalKind;
  title: string;
  payload: { change: PathChange | GraphChange; rationale?: string };
  status: 'pending' | 'applied' | 'rejected';
  decided: number | null;
}

const rowOf = (r: Record<string, unknown>): StudyProposal => ({
  id: String(r.id),
  at: Number(r.at),
  client: r.client ? String(r.client) : null,
  kind: r.kind as ProposalKind,
  title: String(r.title),
  payload: JSON.parse(String(r.payload)) as StudyProposal['payload'],
  status: r.status as StudyProposal['status'],
  decided: r.decided === null || r.decided === undefined ? null : Number(r.decided),
});

export class Proposals {
  constructor(private readonly svc: StudyService) {}

  list(p: { status?: string } = {}): StudyProposal[] {
    const rows = this.svc.db.sql.prepare(`SELECT * FROM proposals${p.status ? ' WHERE status = ?' : ''} ORDER BY at DESC LIMIT 100`).all(...(p.status ? [p.status] : [])) as Record<string, unknown>[];
    return rows.map(rowOf);
  }

  private get(id: string): StudyProposal {
    const r = this.svc.db.sql.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) throw new StudyError(`Unknown proposal "${id}"`, 404);
    return rowOf(r);
  }

  /** What applying would write, as { file, text } — also the validation step. */
  private render(kind: ProposalKind, change: PathChange | GraphChange): { file: string; text: string | null } {
    const m = this.svc.model();
    const c = m.concepts.get(change.concept);
    if (!c) throw new StudyError(`Unknown concept "${change.concept}"`, 404);
    if (kind === 'path') {
      const ch = change as PathChange;
      const file = m.paths.get(c.id)?.file ?? `semesters/${m.semester}/subjects/${c.subject}/paths/${c.id}.yaml`;
      const text = dumpYaml({ concept: c.id, segments: ch.segments, alternates: ch.alternates ?? m.paths.get(c.id)?.alternates ?? [] });
      parsePath(text, file, c.id); // throws with the field that is wrong
      return { file, text };
    }
    const ch = change as GraphChange;
    for (const x of [...(ch.prereqs ?? []), ...(ch.confusedWith ?? []), ...(ch.mergedInto ? [ch.mergedInto] : [])]) {
      if (!ID_RE.test(x) || !m.concepts.has(x)) throw new StudyError(`Unknown concept "${x}" in the proposed links`);
      if (x === c.id) throw new StudyError('A concept cannot link to itself.');
    }
    const raw = readFileSync(inVault(this.svc.root, c.file), 'utf8');
    const { meta, body } = frontMatter(raw, c.file);
    const next = { ...meta };
    if (ch.prereqs) next.prereqs = ch.prereqs;
    if (ch.confusedWith) next.confusedWith = ch.confusedWith;
    if (ch.mergedInto !== undefined) {
      if (ch.mergedInto) next.mergedInto = ch.mergedInto;
      else delete next.mergedInto;
    }
    return { file: c.file, text: withFrontMatter(next, body) };
  }

  propose(p: { kind: ProposalKind; change: PathChange | GraphChange; rationale?: string; client?: string }): StudyProposal {
    if (p.kind !== 'path' && p.kind !== 'graph') throw new StudyError('kind must be "path" or "graph"');
    if (!p.change || typeof p.change.concept !== 'string') throw new StudyError('change.concept is required');
    this.render(p.kind, p.change);
    const id = `sp-${this.svc.clock().toString(36)}${randomBytes(2).toString('hex')}`;
    const title = p.kind === 'path' ? `New resource path for ${p.change.concept}` : `Link changes for ${p.change.concept}`;
    this.svc.db.sql.prepare('INSERT INTO proposals (id, at, client, kind, title, payload, status) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, this.svc.clock(), p.client ?? null, p.kind, title, JSON.stringify({ change: p.change, ...(p.rationale ? { rationale: p.rationale.slice(0, 500) } : {}) }), 'pending');
    return this.get(id);
  }

  apply(p: { id: string; by?: string }) {
    const pr = this.get(p.id);
    if (pr.status !== 'pending') throw new StudyError(`That proposal is already ${pr.status}.`, 409);
    const { file, text } = this.render(pr.kind, pr.payload.change);
    const full = inVault(this.svc.root, file);
    const before = existsSync(full) ? readFileSync(full, 'utf8') : null;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text ?? '');
    const seq = this.audit(p.by ?? pr.client ?? 'app', `proposal ${pr.id}: ${pr.title}`, file, before, text);
    this.svc.db.sql.prepare("UPDATE proposals SET status = 'applied', decided = ? WHERE id = ?").run(this.svc.clock(), pr.id);
    this.svc.reindex();
    return { ok: true, file, audit: seq };
  }

  reject(p: { id: string }) {
    const pr = this.get(p.id);
    if (pr.status !== 'pending') throw new StudyError(`That proposal is already ${pr.status}.`, 409);
    this.svc.db.sql.prepare("UPDATE proposals SET status = 'rejected', decided = ? WHERE id = ?").run(this.svc.clock(), pr.id);
    return { ok: true };
  }

  audit(actor: string, action: string, target: string, before: string | null, after: string | null): number {
    const r = this.svc.db.sql.prepare('INSERT INTO audit (at, actor, action, target, before, after) VALUES (?, ?, ?, ?, ?, ?)').run(this.svc.clock(), actor.slice(0, 60), action.slice(0, 300), target, before, after);
    return Number(r.lastInsertRowid);
  }

  auditList(limit = 50) {
    return (this.svc.db.sql.prepare('SELECT seq, at, actor, action, target, undone FROM audit ORDER BY seq DESC LIMIT ?').all(limit) as { seq: number; at: number; actor: string; action: string; target: string; undone: number }[]).map((r) => ({ ...r, undone: !!r.undone }));
  }

  /** Put the file back the way it was before that change — only if nobody changed it since. */
  undo(p: { seq: number }) {
    const r = this.svc.db.sql.prepare('SELECT * FROM audit WHERE seq = ?').get(p.seq) as { seq: number; target: string; before: string | null; after: string | null; undone: number } | undefined;
    if (!r) throw new StudyError('That change does not exist.', 404);
    if (r.undone) throw new StudyError('Already undone.', 409);
    const full = inVault(this.svc.root, r.target);
    const now = existsSync(full) ? readFileSync(full, 'utf8') : null;
    if (now !== r.after) throw new StudyError(`${r.target} changed after this edit, so undo would overwrite newer work. Use the vault's git history instead.`, 409);
    if (r.before === null) rmSync(full, { force: true });
    else writeFileSync(full, r.before);
    this.svc.db.sql.prepare('UPDATE audit SET undone = 1 WHERE seq = ?').run(r.seq);
    this.svc.reindex();
    return { ok: true, restored: r.target };
  }
}

/** Phone and MCP captures land in inbox/ as Markdown for the next ingest job. */
export function capture(svc: StudyService, p: { text: string; url?: string; subject?: string; from?: string }) {
  const now = svc.clock();
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
  let file = join(svc.L.inbox, `${stamp}-capture.md`);
  for (let i = 2; existsSync(file); i++) file = join(svc.L.inbox, `${stamp}-${i}-capture.md`);
  mkdirSync(svc.L.inbox, { recursive: true });
  const meta: Record<string, unknown> = { captured: d.toISOString(), from: p.from ?? 'app', ...(p.subject ? { subject: p.subject } : {}), ...(p.url ? { url: p.url } : {}) };
  writeFileSync(file, withFrontMatter(meta, `\n${p.text.trim().slice(0, 20_000)}\n`));
  return { ok: true, file: rel(svc.root, file) };
}
