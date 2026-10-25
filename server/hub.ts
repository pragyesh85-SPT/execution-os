import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { focusState, wakeDue } from '../src/core/engine';
import * as ops from '../src/core/ops';
import { expireProposals, hasExpired } from '../src/core/proposals';
import type { Change } from '../src/core/sync';
import type { Doc } from '../src/core/types';
import { logicalDate } from '../src/core/time';
import { HubDb } from './db';
import { listAudit, undoAudit, lastSuccess } from './mcp/audit';
import { createConnector, type Connector } from './mcp/connector';
import type { GatewayOptions } from './mcp/gateway';
import type { Tunnel } from './tunnel';

// The Execution OS hub — your PC is the server and the database for every device.
// - serves the built web app
// - keeps the single source of truth in a SQLite file (with full history + daily backups)
// - accepts changes from devices only when they were based on the latest version,
//   so two devices can never silently overwrite each other
// - answers the browser extension ("is focus on right now?")
// Requests from this PC (loopback) are trusted; other devices must send the pairing PIN.

export interface HubOptions {
  port: number;
  dbFile: string;
  legacyJson?: string; // old v1 JSON store, imported once on first start
  distDir: string;
  host?: string;
  log?: (msg: string) => void;
  mcpPort?: number; // AI connector gateway (default 4748, loopback only)
  tunnel?: Tunnel; // Tailscale control (tests inject a fake)
  gateway?: Omit<GatewayOptions, 'db' | 'port' | 'publicHost' | 'log'>;
}

export interface Endpoint {
  url: string;
  kind: 'wifi' | 'tailscale';
}

export interface Hub {
  port: number;
  pin: string;
  db: HubDb;
  getDoc: () => Doc;
  lanUrls: () => string[];
  endpoints: () => Endpoint[];
  connector: Connector;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
};

function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Tailscale hands out addresses in 100.64.0.0/10. */
const isTailscale = (ip: string) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

export function startHub(opts: HubOptions): Promise<Hub> {
  const log = opts.log ?? (() => {});
  const db = new HubDb(opts.dbFile, opts.legacyJson);
  try {
    const b = db.backupIfDue();
    if (b) log(`backup ok: ${b}`);
  } catch (e) {
    log(`backup failed: ${(e as Error).message}`);
  }
  const backupTimer = setInterval(() => {
    try {
      db.backupIfDue();
    } catch {
      /* try again next hour */
    }
  }, 60 * 60 * 1000);
  // Pending proposals that passed their expiry become "expired" (idempotent, writes only changes).
  const expireTimer = setInterval(() => {
    try {
      if (hasExpired(db.doc, Date.now())) db.mutate(expireProposals(), 'hub');
    } catch (e) {
      log(`proposal expiry failed: ${(e as Error).message}`);
    }
  }, 10 * 60 * 1000);

  const endpoints = (): Endpoint[] =>
    lanAddresses().map((ip) => ({ url: `http://${ip}:${opts.port}`, kind: isTailscale(ip) ? 'tailscale' : 'wifi' }));

  const distRoot = resolve(opts.distDir);
  const serveStatic = (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const full = normalize(join(distRoot, rel));
    if (!full.startsWith(distRoot + sep) && full !== distRoot) {
      res.writeHead(403).end();
      return;
    }
    let file = full;
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(distRoot, 'index.html'); // SPA fallback
    if (!existsSync(file)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Web app not built yet. Run: npm run build');
      return;
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const immutable = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    if (req.method === 'HEAD') return void res.end();
    res.end(readFileSync(file));
  };


  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-EOS-PIN,X-EOS-DEVICE');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    if (!path.startsWith('/api/')) return serveStatic(req, res, path);
    if (req.headers.authorization && !req.headers['x-eos-pin'] && !isLoopback(req)) {
      // A connector token is not a sync credential: the sync API never accepts it.
      return send(res, 401, { error: 'Pairing PIN required. Connector tokens only work on the AI connector.' });
    }

    const local = isLoopback(req);
    if (path === '/api/ping') return send(res, 200, { ok: true, app: 'execution-os', version: 2, appVersion: __APP_VERSION__, needsPin: !local, rev: db.rev });
    if (!local && req.headers['x-eos-pin'] !== db.pin) {
      return send(res, 401, { error: 'Pairing PIN required. Find it on the PC under Settings → Devices & sync.' });
    }
    const device = String(req.headers['x-eos-device'] ?? (local ? 'this PC' : 'device')).slice(0, 60);

    try {
      if ((path === '/api/sync' || path === '/api/state') && req.method === 'GET') {
        const since = Number(url.searchParams.get('rev') ?? -1);
        if (since === db.rev) return send(res, 200, { rev: db.rev, same: true });
        return send(res, 200, { rev: db.rev, doc: db.doc });
      }
      if (path === '/api/sync/push' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req)) as { changes?: Change[] };
        const changes = Array.isArray(body.changes) ? body.changes.filter((c) => c && c.col && c.id && c.record) : [];
        const result = db.push(changes, device);
        if (result.accepted) log(`${device}: ${result.accepted} change(s) saved, rev ${result.rev}`);
        return send(res, 200, { ...result, doc: db.doc });
      }
      if (path === '/api/focus' && req.method === 'GET') {
        const now = Date.now();
        const f = focusState(db.doc, now);
        const w = wakeDue(db.doc, now);
        return send(res, 200, {
          active: f.active,
          until: f.until ?? null,
          pausedUntil: f.pausedUntil ?? null,
          block: f.block ? { title: f.block.title, category: f.block.category } : null,
          mission: f.mission ?? null,
          blocked: f.blocked,
          allowed: f.allowed,
          keywords: f.keywords,
          wakeDue: w.due,
          date: logicalDate(now, db.doc.settings.dayStart),
        });
      }
      if (path === '/api/later' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 64 * 1024)) as { url?: string; title?: string };
        const url = typeof body.url === 'string' ? body.url.slice(0, 2000) : undefined;
        db.mutate(ops.addLater(String(body.title || url || 'Saved link').slice(0, 300), url), 'extension');
        return send(res, 200, { ok: true });
      }
      if (path === '/api/distraction' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 16 * 1024)) as { minutes?: number; source?: string; kind?: string };
        const minutes = Math.max(0, Math.min(600, Number(body.minutes) || 0));
        const kind = body.kind === 'urge_resisted' ? 'urge_resisted' : 'unplanned';
        db.mutate(ops.logDistraction(minutes, String(body.source ?? 'Browser').slice(0, 60), kind), 'extension');
        return send(res, 200, { ok: true });
      }
      if (path === '/api/history' && req.method === 'GET') {
        const col = url.searchParams.get('col') as Change['col'] | null;
        const id = url.searchParams.get('id');
        if (!col || !id) return send(res, 400, { error: 'col and id required' });
        return send(res, 200, { history: db.history(col, id) });
      }
      // ---------- AI activity (all paired devices) ----------
      if (path === '/api/ai-activity' && req.method === 'GET') {
        return send(res, 200, { entries: listAudit(db, 100).map(({ args, ...e }) => ({ ...e, args: args.slice(0, 300) })), last: lastSuccess(db) });
      }
      if (path === '/api/ai-activity/undo' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req, 4096)) as { seq?: number };
        const r = undoAudit(db, Number(body.seq), `undo by ${device}`);
        if (r.ok) log(`${device}: undid AI activity #${body.seq}`);
        return send(res, r.ok ? 200 : 409, r);
      }

      // ---------- AI connector control (this PC only) ----------
      if (path === '/api/connector') {
        if (!local) return send(res, 403, { error: 'Only available on the hub PC' });
        if (req.method === 'GET') return send(res, 200, url.searchParams.get('check') ? await connector.check() : connector.status());
        if (req.method === 'POST') {
          const body = JSON.parse(await readBody(req, 4096)) as { action?: string; client?: string };
          const client = String(body.client ?? 'claude').toLowerCase();
          switch (body.action) {
            case 'enable':
              return send(res, 200, await connector.enable());
            case 'disable':
              return send(res, 200, await connector.disable());
            case 'publish':
              return send(res, 200, { result: await connector.publish(), status: connector.status() });
            case 'unpublish':
              return send(res, 200, { result: await connector.unpublish(), status: connector.status() });
            case 'rotate':
              // The token is returned exactly once, to this PC only. It is never stored in clear.
              return send(res, 200, { client, token: connector.rotate(client), status: connector.status() });
            case 'revoke':
              connector.revoke(client);
              return send(res, 200, connector.status());
            default:
              return send(res, 400, { error: 'Unknown action' });
          }
        }
      }

      if (path === '/api/info' && req.method === 'GET') {
        if (!local) return send(res, 403, { error: 'Only available on the hub PC' });
        return send(res, 200, {
          pin: db.pin,
          port: opts.port,
          urls: endpoints().map((e) => e.url),
          endpoints: endpoints(),
          dbFile: db.file,
          backupDir: db.backupDir,
          backups: db.backups().slice(0, 5),
          stats: db.stats(),
        });
      }
      if (path === '/api/backup' && req.method === 'POST') {
        if (!local) return send(res, 403, { error: 'Only available on the hub PC' });
        return send(res, 200, { file: db.backupIfDue(), backups: db.backups().slice(0, 5) });
      }
      return send(res, 404, { error: 'Not found' });
    } catch (err) {
      log(`API error on ${path}: ${(err as Error).message}`);
      return send(res, 400, { error: (err as Error).message });
    }
  });

  const connector = createConnector({ db, port: opts.mcpPort ?? 4748, tunnel: opts.tunnel, log, gateway: opts.gateway });

  return new Promise((resolveHub, reject) => {
    server.once('error', (e) => {
      clearInterval(backupTimer);
      clearInterval(expireTimer);
      db.close();
      reject(e);
    });
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      void connector.start();
      log(`Execution OS hub on http://localhost:${opts.port} · database ${opts.dbFile}`);
      resolveHub({
        port: opts.port,
        pin: db.pin,
        db,
        getDoc: () => db.doc,
        lanUrls: () => endpoints().map((e) => e.url),
        endpoints,
        connector,
        close: async () => {
          clearInterval(backupTimer);
          clearInterval(expireTimer);
          await connector.close();
          await new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          });
          db.close();
        },
      });
    });
  });
}
