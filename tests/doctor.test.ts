import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubDb } from '../server/db';
import { healthy, runDoctor } from '../server/doctor';
import type { Tunnel } from '../server/tunnel';

const noTailscale: Tunnel = {
  info: async () => ({ installed: false, running: false, dnsName: null, state: null }),
  funnelOn: async () => ({ ok: false, message: '' }),
  funnelOff: async () => ({ ok: true, message: '' }),
  funnelActive: async () => false,
  serveOn: async () => ({ ok: false, message: '' }),
  serveActive: async () => false,
};

describe('doctor', () => {
  it('reports every failure or warning with one concrete fix', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eos-doc-'));
    const file = join(dir, 'execution-os.db');
    new HubDb(file).close();
    const checks = await runDoctor({ dbFile: file, port: 47998, tunnel: noTailscale, online: false, connector: { enabled: true, listening: false, publicUrl: null, reachable: null } });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.node.status).toBe('ok');
    expect(byId.db.status).toBe('ok');
    expect(byId.schema.detail).toBe('v1');
    expect(byId.hub.status).toBe('fail'); // nothing listens on 47998
    expect(byId.connector.status).toBe('fail');
    expect(byId.tailscale.status).toBe('warn');
    for (const c of checks) if (c.status === 'fail' || c.status === 'warn') expect(c.fix, c.id).toBeTruthy();
    expect(healthy(checks)).toBe(false);
    expect(healthy(checks.filter((c) => c.status !== 'fail'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('flags a missing database without crashing', async () => {
    const checks = await runDoctor({ dbFile: join(tmpdir(), 'does-not-exist', 'x.db'), port: 47998, tunnel: noTailscale, online: false });
    expect(checks.find((c) => c.id === 'db')?.status).toBe('warn');
  });
});
