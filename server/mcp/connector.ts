import type { HubDb } from '../db';
import { sleepOnAcMinutes, tailscale, type TailscaleInfo, type Tunnel, type TunnelResult } from '../tunnel';
import { lastSuccess } from './audit';
import { listClients, revokeToken, rotateToken } from './auth';
import { startGateway, type Gateway, type GatewayOptions } from './gateway';
import { OAuth } from './oauth';

// The AI connector switch. Off by default. Turning it on starts the gateway on 127.0.0.1:4748;
// "Publish" asks Tailscale Funnel to expose only that listener on https://<pc>.ts.net:8443.
// Turning it off closes the listener and removes the Funnel.

export const FUNNEL_PORT = 8443;

export interface ConnectorStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  localUrl: string;
  publicUrl: string | null;
  clients: { client: string; createdAt: number; lastUsed: number | null }[];
  tailscale: TailscaleInfo | null;
  funnel: boolean | null;
  reachable: boolean | null;
  checkedAt: number | null;
  sleepOnAcMin: number | null;
  lastAiRun: { at: number; client: string; tool: string } | null;
  enableUrl?: string;
}

export interface Connector {
  start(): Promise<void>;
  enable(): Promise<ConnectorStatus>;
  disable(): Promise<ConnectorStatus>;
  publish(): Promise<TunnelResult>;
  unpublish(): Promise<TunnelResult>;
  check(): Promise<ConnectorStatus>;
  status(): ConnectorStatus;
  rotate(client: string): string;
  revoke(client: string): void;
  close(): Promise<void>;
  oauth: OAuth;
}

export function createConnector(opts: { db: HubDb; port: number; tunnel?: Tunnel; log?: (m: string) => void; gateway?: Omit<GatewayOptions, 'db' | 'port' | 'publicHost' | 'log'>; oauthAccessTtlMs?: number }): Connector {
  const { db, port } = opts;
  const tunnel = opts.tunnel ?? tailscale;
  const log = opts.log ?? (() => {});
  let gw: Gateway | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let last: Pick<ConnectorStatus, 'tailscale' | 'funnel' | 'reachable' | 'checkedAt' | 'sleepOnAcMin' | 'enableUrl'> = { tailscale: null, funnel: null, reachable: null, checkedAt: null, sleepOnAcMin: null };
  const publicHost = () => db.getMeta('mcp.publicHost') ?? null;
  const oauth = new OAuth(db, { accessTtlMs: opts.oauthAccessTtlMs });
  /** The base URL the caller used: the public Funnel name, or this PC. */
  const baseFor = (host: string | undefined) => {
    const pub = publicHost();
    const h = (host ?? '').toLowerCase();
    return pub && (h === pub || h.startsWith(`${pub}:`)) ? `https://${pub}:${FUNNEL_PORT}` : `http://localhost:${port}`;
  };
  const resources = () => [`http://localhost:${port}/mcp`, `http://127.0.0.1:${port}/mcp`, ...(publicHost() ? [`https://${publicHost()}:${FUNNEL_PORT}/mcp`] : [])];
  const oauthGateway: Pick<GatewayOptions, 'extraRoutes' | 'authenticate' | 'wwwAuthenticate'> = {
    extraRoutes: (req, res, url) => oauth.handle(req, res, url, baseFor(req.headers.host)),
    authenticate: (req) => {
      const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim());
      return m ? (oauth.verify(m[1], resources())?.label ?? null) : null;
    },
    wwwAuthenticate: (req) => oauth.wwwAuthenticate(baseFor(req.headers.host)),
  };

  const status = (): ConnectorStatus => {
    const host = publicHost();
    const run = lastSuccess(db);
    return {
      enabled: db.getMeta('mcp.enabled') === '1',
      listening: !!gw,
      port,
      localUrl: `http://127.0.0.1:${port}/mcp`,
      publicUrl: host ? `https://${host}:${FUNNEL_PORT}/mcp` : null,
      clients: listClients(db),
      ...last,
      lastAiRun: run ? { at: run.at, client: run.client, tool: run.tool } : null,
    };
  };

  const check = async (): Promise<ConnectorStatus> => {
    const info = await tunnel.info().catch(() => null);
    const host = publicHost();
    let funnel: boolean | null = null;
    let reachable: boolean | null = null;
    if (info?.installed && info.running && host) {
      funnel = await tunnel.funnelActive(FUNNEL_PORT, port).catch(() => false);
      if (funnel && gw) {
        try {
          const r = await fetch(`https://${host}:${FUNNEL_PORT}/healthz`, { signal: AbortSignal.timeout(8000) });
          reachable = r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
        } catch {
          reachable = false;
        }
      } else reachable = false;
    }
    last = { ...last, tailscale: info, funnel, reachable, checkedAt: Date.now(), sleepOnAcMin: await sleepOnAcMinutes().catch(() => null) };
    return status();
  };

  const enable = async () => {
    db.setMeta('mcp.enabled', '1');
    if (!gw) {
      gw = await startGateway({ ...oauthGateway, ...(opts.gateway ?? {}), db, port, publicHost, log });
      timer = setInterval(() => void check().catch(() => {}), 5 * 60_000);
    }
    return status();
  };

  const unpublish = async (): Promise<TunnelResult> => {
    if (!publicHost()) return { ok: true, message: 'Not published' };
    const r = await tunnel.funnelOff(FUNNEL_PORT).catch((e: Error) => ({ ok: false, message: e.message }));
    if (r.ok) db.deleteMeta('mcp.publicHost');
    last = { ...last, funnel: r.ok ? false : last.funnel, reachable: r.ok ? false : last.reachable };
    return r;
  };

  const disable = async () => {
    db.setMeta('mcp.enabled', '0');
    if (timer) clearInterval(timer);
    timer = null;
    const closing = gw?.close();
    gw = null;
    await Promise.all([closing, unpublish()]);
    log('AI connector turned off');
    return status();
  };

  const publish = async (): Promise<TunnelResult> => {
    const info = await tunnel.info();
    if (!info.installed) return { ok: false, message: 'Tailscale is not installed. Install it from https://tailscale.com/download and sign in, then try again.' };
    if (!info.running || !info.dnsName) return { ok: false, message: 'Tailscale is installed but not signed in. Open Tailscale, sign in, then try again.' };
    if (!gw) await enable();
    const r = await tunnel.funnelOn(FUNNEL_PORT, `http://127.0.0.1:${port}`);
    last = { ...last, enableUrl: r.enableUrl };
    if (r.ok) {
      db.setMeta('mcp.publicHost', info.dnsName);
      await check();
    }
    return { ...r, url: r.ok ? `https://${info.dnsName}:${FUNNEL_PORT}/mcp` : undefined };
  };

  return {
    async start() {
      if (db.getMeta('mcp.enabled') === '1') {
        try {
          await enable();
          void check().catch(() => {});
        } catch (e) {
          log(`AI connector could not start: ${(e as Error).message}`);
        }
      }
    },
    enable,
    disable,
    publish,
    unpublish,
    check,
    status,
    oauth,
    rotate: (client) => rotateToken(db, client),
    revoke: (client) => revokeToken(db, client),
    async close() {
      if (timer) clearInterval(timer);
      await gw?.close();
      gw = null;
    },
  };
}
