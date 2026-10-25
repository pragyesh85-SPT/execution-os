import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { lanAddresses } from './lan';
import { sleepOnAcMinutes, tailscale, type Tunnel } from './tunnel';

// Health checks with one concrete fix each. Used by `node build/server.cjs doctor` (exit code 0 when
// healthy) and by Settings → Health. Nothing here changes anything; it only looks.

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorContext {
  dbFile: string;
  port: number;
  tunnel?: Tunnel;
  connector?: { enabled: boolean; listening: boolean; publicUrl: string | null; reachable: boolean | null };
  devices?: { name: string; lastSeen: number | null; revokedAt: number | null }[];
  online?: boolean; // allow the clock check over the internet (default true)
}

const MIN_NODE = [22, 5];

function nodeCheck(): Check {
  const [maj, min] = process.versions.node.split('.').map(Number);
  const ok = maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]);
  return { id: 'node', label: 'Node.js', status: ok ? 'ok' : 'fail', detail: `v${process.versions.node}`, fix: ok ? undefined : 'Install Node.js 24 LTS from https://nodejs.org (22.5 is the minimum).' };
}

function dbChecks(file: string): Check[] {
  if (!existsSync(file)) return [{ id: 'db', label: 'Database', status: 'warn', detail: `No database yet at ${file}`, fix: 'Start Execution OS once; it creates the database.' }];
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const integrity = Object.values(db.prepare('PRAGMA integrity_check').get() as Record<string, string>)[0];
      const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta WHERE key IN ('rev','schemaVersion')").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
      const records = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as { n: number }).n;
      return [
        { id: 'db', label: 'Database', status: integrity === 'ok' ? 'ok' : 'fail', detail: integrity === 'ok' ? `${records} records, revision ${meta.rev ?? 0}` : `integrity check: ${integrity}`, fix: integrity === 'ok' ? undefined : 'Quit Execution OS and restore the latest backup: node build/server.cjs restore "<backups folder>\\execution-os-<date>.db".' },
        { id: 'schema', label: 'Schema version', status: 'ok', detail: `v${meta.schemaVersion ?? 1}` },
      ];
    } finally {
      db.close();
    }
  } catch (e) {
    return [{ id: 'db', label: 'Database', status: 'fail', detail: (e as Error).message, fix: 'Quit every copy of Execution OS, then run doctor again. If it persists, restore a backup.' }];
  }
}

function backupCheck(file: string): Check {
  const dir = join(dirname(file), 'backups');
  const list = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.db')) : [];
  if (!list.length) return { id: 'backup', label: 'Last backup', status: 'warn', detail: 'No backups yet', fix: 'Start Execution OS (it backs up daily) or run: node build/server.cjs backup' };
  const newest = Math.max(...list.map((f) => statSync(join(dir, f)).mtimeMs));
  const hours = (Date.now() - newest) / 3_600_000;
  return { id: 'backup', label: 'Last backup', status: hours < 26 ? 'ok' : 'warn', detail: `${hours < 1 ? 'less than an hour' : `${Math.round(hours)} h`} ago · ${list.length} kept`, fix: hours < 26 ? undefined : 'Keep Execution OS running (it backs up daily), or run: node build/server.cjs backup' };
}

function diskCheck(file: string): Check {
  try {
    const s = statfsSync(existsSync(dirname(file)) ? dirname(file) : '.');
    const freeMb = Math.round((s.bavail * s.bsize) / 1048576);
    return { id: 'disk', label: 'Free disk space', status: freeMb > 500 ? 'ok' : 'warn', detail: `${freeMb >= 1024 ? `${(freeMb / 1024).toFixed(1)} GB` : `${freeMb} MB`} free`, fix: freeMb > 500 ? undefined : 'Free some space on this drive (backups need room).' };
  } catch {
    return { id: 'disk', label: 'Free disk space', status: 'skip', detail: 'could not read' };
  }
}

async function portChecks(port: number): Promise<Check[]> {
  const out: Check[] = [];
  let running = false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
    running = ((await r.json()) as { app?: string }).app === 'execution-os';
  } catch {
    /* not running */
  }
  out.push({ id: 'hub', label: `Hub on port ${port}`, status: running ? 'ok' : 'fail', detail: running ? 'listening' : 'not running', fix: running ? undefined : 'Start Execution OS (Windows app), or run: npm run serve' });
  if (!running) return out;
  for (const ip of lanAddresses()) {
    let ok = false;
    try {
      const r = await fetch(`http://${ip}:${port}/api/ping`, { signal: AbortSignal.timeout(2000) });
      ok = r.ok;
    } catch {
      /* blocked */
    }
    out.push({ id: `lan-${ip}`, label: `Reachable on ${ip}`, status: ok ? 'ok' : 'warn', detail: ok ? 'yes' : 'no answer', fix: ok ? undefined : `Allow Execution OS through Windows Firewall (Windows asks on first start — choose "Private networks"), or run as admin: netsh advfirewall firewall add rule name="Execution OS" dir=in action=allow protocol=TCP localport=${port} profile=private` });
  }
  return out;
}

function firewallCheck(port: number): Promise<Check> {
  if (process.platform !== 'win32') return Promise.resolve({ id: 'firewall', label: 'Firewall rule', status: 'skip', detail: 'Windows only' });
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'], { timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve({ id: 'firewall', label: 'Firewall rule', status: 'skip', detail: 'could not read the firewall rules' });
      const blocks = out.split(/\r?\n\r?\n/);
      const hit = blocks.some((b) => /Enabled:\s+Yes/i.test(b) && /Action:\s+Allow/i.test(b) && (/Execution OS/i.test(b) || new RegExp(`LocalPort:\\s+${port}\\b`).test(b)));
      resolve({
        id: 'firewall',
        label: 'Firewall rule',
        status: hit ? 'ok' : 'warn',
        detail: hit ? 'an allow rule exists' : 'no allow rule found for Execution OS',
        fix: hit ? undefined : `When Windows asks, allow Execution OS on Private networks. Or run in an admin terminal: netsh advfirewall firewall add rule name="Execution OS" dir=in action=allow protocol=TCP localport=${port} profile=private`,
      });
    });
  });
}

async function clockCheck(online: boolean): Promise<Check> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!online) return { id: 'clock', label: 'Clock and time zone', status: 'ok', detail: `${tz} (not compared online)` };
  try {
    const r = await fetch('https://api.github.com', { method: 'HEAD', signal: AbortSignal.timeout(4000) });
    const remote = Date.parse(r.headers.get('date') ?? '');
    if (Number.isNaN(remote)) throw new Error('no date');
    const drift = Math.round((Date.now() - remote) / 1000);
    const ok = Math.abs(drift) < 120;
    return { id: 'clock', label: 'Clock and time zone', status: ok ? 'ok' : 'warn', detail: `${tz}, ${Math.abs(drift)} s ${drift >= 0 ? 'ahead' : 'behind'}`, fix: ok ? undefined : 'Windows Settings → Time & language → Date & time → "Sync now". Wrong clocks ring alarms at the wrong time.' };
  } catch {
    return { id: 'clock', label: 'Clock and time zone', status: 'ok', detail: `${tz} (offline — not compared)` };
  }
}

async function tailscaleChecks(t: Tunnel, port: number): Promise<Check[]> {
  const info = await t.info().catch(() => null);
  if (!info?.installed) return [{ id: 'tailscale', label: 'Tailscale', status: 'warn', detail: 'not installed (sync works only on home Wi-Fi)', fix: 'Optional: install Tailscale (winget install --id Tailscale.Tailscale -e) and sign in on the PC and phone.' }];
  if (!info.running) return [{ id: 'tailscale', label: 'Tailscale', status: 'warn', detail: `installed, ${info.state ?? 'not running'}`, fix: 'Open Tailscale and sign in.' }];
  const serve = await t.serveActive(port).catch(() => false);
  return [
    { id: 'tailscale', label: 'Tailscale', status: 'ok', detail: `signed in as ${info.dnsName}` },
    { id: 'serve', label: 'Secure address (Serve)', status: serve ? 'ok' : 'skip', detail: serve ? `https://${info.dnsName}` : 'off (optional)', fix: serve ? undefined : 'Optional: Settings → Devices & sync → Enable secure address.' },
  ];
}

export async function runDoctor(ctx: DoctorContext): Promise<Check[]> {
  const t = ctx.tunnel ?? tailscale;
  const checks: Check[] = [nodeCheck(), ...dbChecks(ctx.dbFile), backupCheck(ctx.dbFile), diskCheck(ctx.dbFile)];
  const [ports, fw, clock, ts, sleep] = await Promise.all([portChecks(ctx.port), firewallCheck(ctx.port), clockCheck(ctx.online ?? true), tailscaleChecks(t, ctx.port), sleepOnAcMinutes().catch(() => null)]);
  checks.push(...ports, fw, clock, ...ts);
  if (ctx.connector) {
    const c = ctx.connector;
    if (!c.enabled) checks.push({ id: 'connector', label: 'AI connector', status: 'skip', detail: 'off' });
    else
      checks.push({
        id: 'connector',
        label: 'AI connector',
        status: !c.listening ? 'fail' : c.publicUrl && c.reachable === false ? 'warn' : 'ok',
        detail: !c.listening ? 'switched on but not listening' : c.publicUrl ? (c.reachable ? `reachable at ${c.publicUrl}` : `published, last check failed`) : 'on for this PC only',
        fix: !c.listening ? 'Settings → AI connector: switch off and on again (port 4748 may be in use).' : c.publicUrl && c.reachable === false ? 'Make sure Tailscale is running, then press Check in Settings → AI connector.' : undefined,
      });
    if (c.enabled && sleep !== null && sleep > 0 && sleep < 120)
      checks.push({ id: 'power', label: 'Power plan', status: 'warn', detail: `PC sleeps after ${sleep} min on power`, fix: 'Windows Settings → System → Power → "When plugged in, put my device to sleep after": Never. Claude cannot reach a sleeping PC.' });
  }
  if (ctx.devices) {
    const active = ctx.devices.filter((d) => !d.revokedAt);
    const stale = active.filter((d) => !d.lastSeen || Date.now() - d.lastSeen > 7 * 86_400_000);
    checks.push({
      id: 'devices',
      label: 'Paired devices',
      status: stale.length ? 'warn' : 'ok',
      detail: active.length ? `${active.length} paired${stale.length ? `; not seen for a week: ${stale.map((d) => d.name).join(', ')}` : ''}` : 'none paired by QR',
      fix: stale.length ? 'Open the app on those devices once, or revoke them in Settings → Devices & sync.' : undefined,
    });
  }
  return checks;
}

export const healthy = (checks: Check[]) => !checks.some((c) => c.status === 'fail');
