import { existsSync } from 'node:fs';
import { isVault, layout, readVaultConfig } from './vault';
import { StudyDb } from './store';
import type { QueueItem } from '../../src/core/study/types';

// StudyService — every Study OS operation, used by the hub API, the `study` CLI (directly when the hub
// is not running) and the MCP tools. The hub is the only long-lived owner; everything else is a client.

export class StudyError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'StudyError';
  }
}

export interface StudyServiceOptions {
  vault: string;
  clock?: () => number;
  log?: (m: string) => void;
}

export class StudyService {
  readonly root: string;
  readonly db: StudyDb;
  readonly clock: () => number;
  readonly log: (m: string) => void;

  constructor(opts: StudyServiceOptions) {
    this.root = opts.vault;
    if (!existsSync(this.root) || !isVault(this.root)) throw new StudyError(`No Study Vault at ${this.root}. Create it with: study init ${this.root}`, 409);
    this.clock = opts.clock ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.db = new StudyDb(layout(this.root).db);
  }

  get L() {
    return layout(this.root);
  }

  status() {
    const cfg = readVaultConfig(this.root);
    const count = (sql: string) => (this.db.sql.prepare(sql).get() as { n: number }).n;
    return {
      vault: this.root,
      name: cfg.name,
      semester: cfg.current,
      schemaVersion: this.db.schemaVersion,
      counts: {
        concepts: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'concept'"),
        paths: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'path'"),
        packs: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'pack'"),
        labs: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'lab'"),
        questions: count("SELECT COUNT(*) AS n FROM items WHERE kind = 'question'"),
        assets: count('SELECT COUNT(*) AS n FROM assets'),
        events: count('SELECT COUNT(*) AS n FROM events'),
      },
      errors: this.db.fileErrors(),
      backups: this.db.backups().slice(0, 3),
    };
  }

  /** The study queue. Filled from P1 on (ingestion + the learning engine). */
  next(): { items: QueueItem[] } {
    return { items: [] };
  }

  close() {
    this.db.close();
  }
}
