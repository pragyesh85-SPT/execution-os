import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

// Tailscale control for the hub.
//   Funnel (public HTTPS, opt-in): https://<pc>.<tailnet>.ts.net:8443  → 127.0.0.1:4748 (AI connector only)
//   Serve  (private HTTPS, tailnet only): https://<pc>.<tailnet>.ts.net → 127.0.0.1:4747 (web app for phones)
// The sync API is never funnelled. Commands were checked against Tailscale 1.102; when Funnel is not
// allowed by the tailnet policy, Tailscale prints a URL to enable it, which is surfaced as enableUrl.

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  dnsName: string | null; // without the trailing dot
  state: string | null;
}

export interface TunnelResult {
  ok: boolean;
  message: string;
  url?: string;
  enableUrl?: string;
}

export interface Tunnel {
  info(): Promise<TailscaleInfo>;
  funnelOn(port: number, target: string): Promise<TunnelResult>;
  funnelOff(port: number): Promise<TunnelResult>;
  funnelActive(port: number, targetPort: number): Promise<boolean>;
  serveOn(target: string): Promise<TunnelResult>;
  serveActive(targetPort: number): Promise<boolean>;
}

const WIN_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const exe = () => (process.platform === 'win32' && existsSync(WIN_EXE) ? WIN_EXE : 'tailscale');

function run(args: string[], timeout = 15_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(exe(), args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code === 'ENOENT' ? -1 : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

const findUrl = (text: string) => /https:\/\/login\.tailscale\.com\/\S+/.exec(text)?.[0];

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
}

async function serveConfig(): Promise<ServeConfig> {
  const r = await run(['serve', 'status', '--json']);
  try {
    return JSON.parse(r.out) as ServeConfig;
  } catch {
    return {};
  }
}

const proxiesTo = (cfg: ServeConfig, hostPort: (k: string) => boolean, targetPort: number) =>
  Object.entries(cfg.Web ?? {}).some(([k, v]) => hostPort(k) && Object.values(v.Handlers ?? {}).some((h) => (h.Proxy ?? '').includes(`:${targetPort}`)));

export const tailscale: Tunnel = {
  async info() {
    const r = await run(['status', '--json']);
    if (r.code === -1) return { installed: false, running: false, dnsName: null, state: null };
    try {
      const j = JSON.parse(r.out) as { BackendState?: string; Self?: { DNSName?: string } };
      return { installed: true, running: j.BackendState === 'Running', dnsName: j.Self?.DNSName?.replace(/\.$/, '') || null, state: j.BackendState ?? null };
    } catch {
      return { installed: true, running: false, dnsName: null, state: 'unknown' };
    }
  },
  async funnelOn(port, target) {
    const r = await run(['funnel', '--bg', `--https=${port}`, target], 20_000);
    const enableUrl = findUrl(r.out);
    if (r.code !== 0 || enableUrl) return { ok: false, message: enableUrl ? 'Funnel is not allowed on this tailnet yet. Open the link once to allow it, then try again.' : r.out.trim() || 'tailscale funnel failed', enableUrl };
    const info = await tailscale.info();
    return { ok: true, message: 'Funnel on', url: info.dnsName ? `https://${info.dnsName}:${port}` : undefined };
  },
  async funnelOff(port) {
    const r = await run(['funnel', `--https=${port}`, 'off']);
    return { ok: r.code === 0, message: r.code === 0 ? 'Funnel off' : r.out.trim() };
  },
  async funnelActive(port, targetPort) {
    const cfg = await serveConfig();
    const allowed = Object.entries(cfg.AllowFunnel ?? {}).some(([k, v]) => v && k.endsWith(`:${port}`));
    return allowed && proxiesTo(cfg, (k) => k.endsWith(`:${port}`), targetPort);
  },
  async serveOn(target) {
    const r = await run(['serve', '--bg', '--https=443', target], 20_000);
    const enableUrl = findUrl(r.out);
    if (r.code !== 0 || enableUrl) return { ok: false, message: enableUrl ? 'HTTPS is not enabled on this tailnet yet. Open the link once to allow it, then try again.' : r.out.trim() || 'tailscale serve failed', enableUrl };
    const info = await tailscale.info();
    return { ok: true, message: 'Secure address on', url: info.dnsName ? `https://${info.dnsName}` : undefined };
  },
  async serveActive(targetPort) {
    const cfg = await serveConfig();
    return proxiesTo(cfg, (k) => k.endsWith(':443'), targetPort);
  },
};

/** Windows: minutes until the PC sleeps on AC power (0 = never), or null when unknown. */
export function sleepOnAcMinutes(): Promise<number | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], { timeout: 8000, windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(out);
      resolve(m ? Math.round(parseInt(m[1], 16) / 60) : null);
    });
  });
}
