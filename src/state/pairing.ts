import { App as CapApp } from '@capacitor/app';
import { orderUrls, parsePair, type PairPayload } from '../lib/pairing';
import { isAndroid, isCapacitor, platformLabel } from '../lib/platform';
import { useStore } from './store';
import { syncNow } from './sync';

// Device side of one-scan pairing. A scanned or opened link carries #pair=<payload>; the device
// claims the single-use token from the hub (trying its addresses in order), stores the device
// token and every address, and starts syncing. No IP address, no PIN.

export type ClaimOutcome = { ok: true; hubName: string } | { ok: false; message: string };

interface ClaimReply {
  deviceId?: string;
  deviceToken?: string;
  hubId?: string;
  hubName?: string;
  urls?: string[];
  claimId?: string;
  status?: string;
  error?: string;
}

function save(reply: ClaimReply, usedUrl: string, payload: PairPayload) {
  const urls = orderUrls([...(reply.urls ?? []), ...payload.u]);
  useStore.getState().setLocal({
    syncToken: reply.deviceToken!,
    hubId: reply.hubId ?? payload.h,
    hubName: reply.hubName ?? payload.n,
    hubUrls: urls,
    lastGoodUrl: usedUrl === '.' ? '' : usedUrl,
    syncUrl: usedUrl === '.' ? '' : usedUrl, // older code paths still read this
    syncPin: '',
  });
  syncNow();
}

async function waitForApproval(base: string, claimId: string): Promise<ClaimReply | null> {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = (await (await fetch(`${base}/api/pair/status?claimId=${encodeURIComponent(claimId)}`, { cache: 'no-store' })).json()) as ClaimReply;
      if (r.status === 'approved') return r;
      if (r.status === 'denied') return null;
    } catch {
      /* keep waiting */
    }
  }
  return null;
}

export async function claimPairing(payload: PairPayload, opts: { sameOrigin?: boolean; onWaiting?: () => void } = {}): Promise<ClaimOutcome> {
  const local = useStore.getState().local;
  const deviceName = (local.deviceName || (isAndroid ? 'Android phone' : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : platformLabel)).slice(0, 60);
  const platform = isAndroid ? 'android' : /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : 'web';
  const bases = [...(opts.sameOrigin ? ['.'] : []), ...orderUrls(payload.u)];
  const lastError = 'Could not reach the PC. Is it on, with Execution OS running, on the same Wi-Fi or Tailscale?';
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/api/pair/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: payload.t, deviceName, platform }),
        signal: AbortSignal.timeout(5000),
      });
      const reply = (await res.json()) as ClaimReply;
      if (res.status === 200 && reply.deviceToken) {
        save(reply, base, payload);
        return { ok: true, hubName: reply.hubName ?? payload.n };
      }
      if (res.status === 202 && reply.claimId) {
        opts.onWaiting?.();
        const approved = await waitForApproval(base, reply.claimId);
        if (approved?.deviceToken) {
          save(approved, base, payload);
          return { ok: true, hubName: approved.hubName ?? payload.n };
        }
        return { ok: false, message: 'The PC did not approve this device.' };
      }
      return { ok: false, message: reply.error ?? `The PC answered ${res.status}.` };
    } catch {
      /* try the next address */
    }
  }
  return { ok: false, message: lastError };
}

/** Pair from a scanned QR text or a deep link. */
export async function pairFromText(text: string, opts: { onWaiting?: () => void } = {}): Promise<ClaimOutcome> {
  const p = parsePair(text);
  if (!p) return { ok: false, message: 'That QR code is not an Execution OS pairing code. Open Settings → Devices & sync on the PC.' };
  return claimPairing(p, opts);
}

let pendingLink: PairPayload | null = null;

/** The pairing link that opened this page, if any (removed from the address bar immediately). */
export function takePairLink(): PairPayload | null {
  const p = pendingLink;
  pendingLink = null;
  return p;
}

/** Call once at start-up, before sync starts. */
export function initPairingLinks() {
  if (typeof location !== 'undefined' && location.hash.includes('pair=')) {
    pendingLink = parsePair(location.hash);
    history.replaceState(null, '', location.pathname + location.search); // never keep the token in the address bar
  }
  if (isCapacitor) {
    void CapApp.addListener('appUrlOpen', ({ url }) => {
      const p = parsePair(url);
      if (!p) return;
      const st = useStore.getState();
      st.toast('Pairing with your PC…', 'info');
      void claimPairing(p).then((r) => st.toast(r.ok ? `Connected to ${r.hubName}.` : r.message, r.ok ? 'success' : 'warn'));
    });
  }
}
