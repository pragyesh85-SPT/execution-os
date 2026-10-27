import type { IncomingMessage, ServerResponse } from 'node:http';
import { isOn } from '../../src/core/features';
import type { HubDb } from '../db';
import { METHODS, type CallCtx } from './api';
import { publicTutor, StudyConfigFile } from './config';
import { StudyError, StudyService } from './service';
import { isVault } from './vault';

// Study OS inside the Execution OS hub. Nothing happens while the "study" flag is off: no vault is
// opened, no timer writes, every /api/study route answers 404. Switching the flag on (from any device,
// through sync) starts it within a minute; switching it off closes it. Nothing is deleted either way.

export interface StudyModuleOptions {
  hubDb: HubDb;
  vault?: string; // fixed vault (tests); otherwise EOS_STUDY_VAULT / study.json / default
  clock?: () => number;
  log?: (m: string) => void;
}

type Send = (res: ServerResponse, status: number, body: unknown) => void;

export class StudyModule {
  readonly config: StudyConfigFile;
  private svc: StudyService | null = null;
  private timer: ReturnType<typeof setInterval>;
  private readonly log: (m: string) => void;

  constructor(private readonly opts: StudyModuleOptions) {
    this.config = new StudyConfigFile(opts.hubDb.file);
    this.log = opts.log ?? (() => {});
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref?.();
  }

  get enabled(): boolean {
    return isOn(this.opts.hubDb.doc.settings, 'study');
  }

  vaultPath(): string {
    return this.opts.vault ?? this.config.vault();
  }

  /** The open service, or null when the flag is off or there is no vault yet. */
  service(): StudyService | null {
    if (!this.enabled) {
      this.stop();
      return null;
    }
    const vault = this.vaultPath();
    if (this.svc && this.svc.root !== vault) this.stop();
    if (!this.svc && isVault(vault)) {
      this.svc = new StudyService({ vault, clock: this.opts.clock, log: this.log });
      try {
        const b = this.svc.db.backupIfDue();
        if (b) this.log(`study backup ok: ${b}`);
      } catch (e) {
        this.log(`study backup failed: ${(e as Error).message}`);
      }
    }
    return this.svc;
  }

  /** Once a minute: follow the flag, keep the daily backup. Later phases add drift and the summary. */
  tick() {
    try {
      const s = this.service();
      s?.db.backupIfDue();
    } catch (e) {
      this.log(`study tick failed: ${(e as Error).message}`);
    }
  }

  setup() {
    const vault = this.vaultPath();
    return { enabled: this.enabled, vault, exists: isVault(vault), tutor: publicTutor(this.config.tutor()) };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, ctx: CallCtx, readBody: (req: IncomingMessage, limit?: number) => Promise<string>, send: Send): Promise<void> {
    const name = url.pathname.slice('/api/study/'.length);
    if (!this.enabled) return send(res, 404, { error: 'Study OS is switched off (Settings → Labs → Study OS).', enabled: false });
    try {
      let params: Record<string, unknown> = {};
      if (req.method === 'POST') {
        const raw = await readBody(req, 32 * 1024 * 1024);
        params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } else if (url.searchParams.get('p')) params = JSON.parse(url.searchParams.get('p')!) as Record<string, unknown>;
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new StudyError('Parameters must be a JSON object.');

      if (name === 'setup') return send(res, 200, this.setup());
      if (name === 'config') {
        if (!ctx.local) return send(res, 403, { error: 'Only available on the hub PC' });
        if (req.method === 'POST' && typeof params.vault === 'string' && params.vault.trim()) {
          this.config.write({ vault: params.vault.trim() });
          this.stop();
        }
        return send(res, 200, this.setup());
      }

      const m = METHODS[name];
      if (!m) return send(res, 404, { error: `Unknown Study OS method "${name}".` });
      if (m.local && !ctx.local) return send(res, 403, { error: 'Only available on the hub PC' });
      if (m.write && req.method !== 'POST') return send(res, 405, { error: 'POST required' });
      const svc = this.service();
      if (!svc) return send(res, 409, { error: `No Study Vault at ${this.vaultPath()}. On the PC run: npm run study -- init "${this.vaultPath()}"`, setup: false, vault: this.vaultPath() });
      const out = await m.run(svc, params, ctx);
      return send(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof StudyError ? e.status : 400;
      if (!(e instanceof StudyError)) this.log(`study API error on ${name}: ${(e as Error).message}`);
      return send(res, status, { error: (e as Error).message });
    }
  }

  stop() {
    if (!this.svc) return;
    this.svc.close();
    this.svc = null;
  }

  close() {
    clearInterval(this.timer);
    this.stop();
  }
}
