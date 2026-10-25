import { networkInterfaces } from 'node:os';

/** IPv4 addresses of this PC on its networks (home Wi-Fi, Ethernet, Tailscale). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

/** Tailscale hands out addresses in 100.64.0.0/10. */
export const isTailscaleIp = (ip: string) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
};
