import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isOn } from '../../src/core/features';
import type { HubDb } from '../db';
import { ensureAuditTable } from './audit';
import { ensureAuthTables, Guard, verifyBearer } from './auth';
import { buildServer, type ToolCtx } from './tools';

// The MCP gateway: a separate listener that binds to 127.0.0.1 only and is reached from the internet
// only through Tailscale Funnel when the user turns it on. The sync API (port 4747) is never exposed.
//   /healthz — { ok, app } and nothing else
//   /mcp     — POST only (stateless Streamable HTTP, JSON responses), bearer token required
// Every other path is 404. Wrong Host header → 421 (DNS-rebinding guard). No CORS on this listener.

export interface GatewayOptions {
  db: HubDb;
  port: number;
  publicHost?: () => string | null; // e.g. "pc.tail1234.ts.net"
  log?: (m: string) => void;
  ctx?: Omit<ToolCtx, 'db' | 'client'>;
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean; // OAuth (phase 11)
  authenticate?: (req: IncomingMessage) => string | null; // alternative auth (OAuth access tokens)
  wwwAuthenticate?: (req: IncomingMessage) => string;
  rateLimitPerMin?: number; // default 60 requests per minute per address
}

export interface Gateway {
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY = 256 * 1024;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The caller's address: the first X-Forwarded-For hop when a local proxy (Tailscale) forwarded it. */
export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

export function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const { db, port } = opts;
  const log = opts.log ?? (() => {});
  ensureAuthTables(db);
  ensureAuditTable(db);
  const guard = new Guard(opts.rateLimitPerMin ?? 60);
  const challenge = (req: IncomingMessage) => opts.wwwAuthenticate?.(req) ?? 'Bearer realm="execution-os"';

  const hostAllowed = (host: string | undefined) => {
    if (!host) return false;
    const h = host.toLowerCase();
    const local = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (local.includes(h)) return true;
    const pub = opts.publicHost?.()?.toLowerCase();
    return !!pub && (h === pub || h === `${pub}:8443` || h === `${pub}:443`);
  };

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) return json(res, 421, { error: 'Misdirected request' });
      const url = new URL(req.url ?? '/', 'http://gateway');
      if (url.pathname === '/healthz') return json(res, 200, { ok: true, app: 'execution-os-mcp' });
      if (opts.extraRoutes && (await opts.extraRoutes(req, res, url))) return;
      if (url.pathname !== '/mcp') return json(res, 404, { error: 'Not found' });
      const ip = clientIp(req);
      if (guard.limited(ip)) return json(res, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });
      const client = verifyBearer(db, req.headers.authorization as string | undefined) ?? opts.authenticate?.(req) ?? null;
      if (!client) {
        guard.failed(ip);
        return json(res, 401, { error: 'A valid connector token is required.' }, { 'WWW-Authenticate': challenge(req) });
      }
      guard.succeeded(ip);
      if (!isOn(db.doc.settings, 'mcp')) return json(res, 503, { error: 'The AI connector is switched off in Execution OS (Settings → Labs).' });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only (stateless MCP)' }, { Allow: 'POST' });
      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        if ((e as Error).message === 'too large') return json(res, 413, { error: 'Request larger than 256 KB' });
        return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
      const mcp = buildServer({ ...(opts.ctx ?? {}), db, client });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`mcp gateway error: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      log(`AI connector listening on http://127.0.0.1:${port}/mcp`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
