import { CircleCheck, Lock, QrCode, ScanLine, ShieldCheck, Smartphone } from 'lucide-react';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { QrScanner } from '../components/QrScanner';
import { Sheet, Toggle } from '../components/ui';
import { encodePair, PATH_LABEL, type PairPayload } from '../lib/pairing';
import { notify } from '../lib/notify';
import { isCapacitor, openExternal } from '../lib/platform';
import { claimPairing, pairFromText } from '../state/pairing';
import { useStore } from '../state/store';
import { hubRequest, syncNow } from '../state/sync';

// v2 pairing UI (flag "qrPairing"): one QR on the PC, Scan PC on the phone, device list with Revoke.

interface DeviceRow {
  id: string;
  name: string;
  platform: string | null;
  createdAt: number;
  lastSeen: number | null;
  revokedAt: number | null;
}

interface DevicesInfo {
  devices: DeviceRow[];
  requireApproval: boolean;
  pinDisabled: boolean;
  recent: { name: string; at: number }[];
  hubName: string;
  serveUrl: string | null;
}

const ago = (ms: number | null) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** On the hub PC: the one QR to scan, the paired devices, and the secure address. */
export function PcPairingCard() {
  const toast = useStore((s) => s.toast);
  const [qr, setQr] = useState('');
  const [info, setInfo] = useState<DevicesInfo | null>(null);
  const [pending, setPending] = useState<{ claimId: string; deviceName: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const announced = useRef(new Set<string>());

  const refreshQr = useCallback(async () => {
    try {
      const r = (await (await hubRequest('pair/start', { method: 'POST', body: '{}' })).json()) as { qrText: string };
      setQr(await QRCode.toDataURL(r.qrText, { margin: 1, width: 360, errorCorrectionLevel: 'M' }));
    } catch {
      setQr('');
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const j = (await (await hubRequest('devices')).json()) as DevicesInfo;
      setInfo(j);
      for (const r of j.recent) {
        const key = `${r.name}@${r.at}`;
        if (announced.current.has(key)) continue;
        announced.current.add(key);
        if (Date.now() - r.at < 15_000) {
          toast(`${r.name} connected.`, 'success');
          void notify('Execution OS', `${r.name} connected`);
          void refreshQr(); // the token was used; show a fresh one
        }
      }
      const p = (await (await hubRequest('pair/pending')).json()) as { pending: { claimId: string; deviceName: string }[] };
      setPending(p.pending);
    } catch {
      /* hub restarting */
    }
  }, [toast, refreshQr]);

  useEffect(() => {
    void refreshQr();
    void refresh();
    const q = window.setInterval(refreshQr, 4 * 60_000); // tokens live 5 minutes
    const d = window.setInterval(refresh, 3000);
    return () => {
      window.clearInterval(q);
      window.clearInterval(d);
    };
  }, [refreshQr, refresh]);

  const option = async (body: Record<string, boolean>) => {
    await hubRequest('devices/options', { method: 'POST', body: JSON.stringify(body) });
    void refresh();
  };
  const active = info?.devices.filter((d) => !d.revokedAt) ?? [];

  return (
    <>
      <section className="card">
        <h2 className="card-title">
          <span>Connect a phone — scan once</span>
          <QrCode size={16} />
        </h2>
        <div className="qr-card">
          {qr ? <img src={qr} alt="Pairing QR code" style={{ width: 240, height: 240 }} /> : <span className="muted">Preparing…</span>}
          <ol className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 14, display: 'grid', gap: 6 }}>
            <li>
              <strong>Android app:</strong> Settings → Devices &amp; sync → <em>Scan PC</em>.
            </li>
            <li>
              <strong>Any phone:</strong> point the camera at this code and open the link. It pairs and offers to install the app.
            </li>
            <li>No address, no PIN. The code changes every few minutes and works once.</li>
          </ol>
        </div>
      </section>

      {pending.length > 0 && (
        <section className="card">
          <h2 className="card-title">Waiting for your approval</h2>
          {pending.map((p) => (
            <div key={p.claimId} className="row between" style={{ padding: '6px 0' }}>
              <span>
                <Smartphone size={14} /> {p.deviceName}
              </span>
              <span className="row" style={{ gap: 6 }}>
                <button className="btn ghost sm" onClick={() => void hubRequest('pair/deny', { method: 'POST', body: JSON.stringify({ claimId: p.claimId }) }).then(refresh)}>
                  Deny
                </button>
                <button className="btn primary sm" onClick={() => void hubRequest('pair/approve', { method: 'POST', body: JSON.stringify({ claimId: p.claimId }) }).then(refresh)}>
                  Approve
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Paired devices</h2>
        {active.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>None yet. Devices paired with the old PIN keep working.</p>
        ) : (
          active.map((d) => (
            <div key={d.id} className="row between" style={{ padding: '8px 0', borderTop: '1px solid var(--line)' }}>
              <span>
                <strong>{d.name}</strong> <span className="faint">· {d.platform ?? 'device'} · last seen {ago(d.lastSeen)}</span>
              </span>
              <button
                className="btn ghost sm danger"
                onClick={() =>
                  void hubRequest('devices/revoke', { method: 'POST', body: JSON.stringify({ id: d.id }) }).then(() => {
                    toast(`${d.name} disconnected. It stops syncing within a few seconds.`, 'info');
                    void refresh();
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))
        )}
        <div className="divider" />
        <div className="setting">
          <div>
            <div className="name">Require approval on this PC</div>
            <div className="desc">A scanned code waits until you tap Approve here.</div>
          </div>
          <Toggle on={!!info?.requireApproval} onChange={(v) => void option({ requireApproval: v })} label="Require approval" />
        </div>
        {active.length > 0 && (
          <div className="setting">
            <div>
              <div className="name">Turn off PIN pairing</div>
              <div className="desc">Once every device uses a scanned pairing, the 6-digit PIN can stop working.</div>
            </div>
            <Toggle on={!!info?.pinDisabled} onChange={(v) => void option({ pinDisabled: v })} label="Turn off PIN pairing" />
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">
          <span>Secure address (recommended for phones and iPhone)</span>
          <Lock size={16} />
        </h2>
        {info?.serveUrl ? (
          <p style={{ margin: 0 }}>
            <CircleCheck size={14} color="var(--ok)" /> <span className="mono">{info.serveUrl}</span> — HTTPS inside your Tailscale network only. The browser version works offline from here and can be installed.
          </p>
        ) : (
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>
              Gives the web app an HTTPS address that only your own devices (signed in to your Tailscale) can open. Needed for offline use and installing on iPhone. Nothing is published to the
              internet.
            </p>
            <div>
              <button
                className="btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = (await (await hubRequest('serve', { method: 'POST', body: '{}' })).json()) as { result: { ok: boolean; message: string; enableUrl?: string }; url: string | null };
                    if (r.result.enableUrl) openExternal(r.result.enableUrl);
                    toast(r.url ? 'Secure address is on.' : r.result.message, r.url ? 'success' : 'warn');
                    void refresh();
                    void refreshQr();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <ShieldCheck size={16} /> Enable secure address
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

/** On a phone or any other device: scan the PC, see the connection, disconnect. */
export function PhonePairingCard() {
  const local = useStore((s) => s.local);
  const sync = useStore((s) => s.sync);
  const setLocal = useStore((s) => s.setLocal);
  const toast = useStore((s) => s.toast);
  const [scan, setScan] = useState(false);
  const canScan = isCapacitor || (typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices);
  const path = sync.path && sync.path !== 'same-origin' ? PATH_LABEL[sync.path] : null;
  return (
    <section className="card">
      <h2 className="card-title">
        <span>Connect to your PC</span>
        <ScanLine size={16} />
      </h2>
      {local.syncToken ? (
        <div className="stack">
          <p style={{ margin: 0 }}>
            Paired with <strong>{local.hubName || 'your PC'}</strong>
            {path ? ` · via ${path}` : ''}. {local.hubUrls.length > 1 ? 'Switches between home Wi-Fi and Tailscale by itself.' : ''}
          </p>
          <div className="btn-row">
            {canScan && (
              <button className="btn" onClick={() => setScan(true)}>
                <ScanLine size={16} /> Scan again
              </button>
            )}
            <button
              className="btn ghost danger"
              onClick={() => {
                setLocal({ syncToken: '', hubUrls: [], lastGoodUrl: '', syncUrl: '', hubId: '', hubName: '' });
                toast('Disconnected. This device now works on its own.', 'info');
              }}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            On the PC open Settings → Devices &amp; sync, then scan the QR code. {canScan ? '' : 'Or point your phone camera at it and open the link.'}
          </p>
          {canScan && (
            <div>
              <button className="btn primary" onClick={() => setScan(true)}>
                <ScanLine size={16} /> Scan PC
              </button>
            </div>
          )}
        </div>
      )}
      <ScanPcSheet open={scan} onClose={() => setScan(false)} />
    </section>
  );
}

export function ScanPcSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<'scan' | 'claiming' | 'waiting'>('scan');
  const onResult = useCallback(
    (text: string) => {
      setState('claiming');
      void pairFromText(text, { onWaiting: () => setState('waiting') }).then((r) => {
        toast(r.ok ? `Connected to ${r.hubName}. Syncing now.` : r.message, r.ok ? 'success' : 'warn');
        setState('scan');
        onClose();
      });
    },
    [toast, onClose],
  );
  return (
    <Sheet open={open} onClose={onClose} title="Scan PC" subtitle="Point the camera at the QR code under Settings → Devices & sync on your PC.">
      {state === 'scan' ? <QrScanner onResult={onResult} /> : <p className="muted">{state === 'waiting' ? 'Waiting for approval on the PC…' : 'Connecting…'}</p>}
    </Sheet>
  );
}

let installPrompt: (Event & { prompt: () => Promise<void> }) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e as Event & { prompt: () => Promise<void> };
  });
}

/** Shown when the page was opened from the PC's pairing QR (phone camera → browser). */
export function PairLinkSheet() {
  const payload = useStore((s) => s.overlay.pairLink);
  const open = useStore((s) => s.open);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const androidBrowser = !isCapacitor && /Android/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  const close = () => {
    setResult(null);
    open({ pairLink: undefined });
  };
  const claimHere = async (p: PairPayload) => {
    setBusy(true);
    const r = await claimPairing(p, { sameOrigin: true, onWaiting: () => setResult({ ok: true, text: 'Waiting for approval on the PC…' }) });
    setBusy(false);
    setResult(r.ok ? { ok: true, text: `Connected to ${r.hubName}. This browser now syncs with your PC.` } : { ok: false, text: r.message });
    if (r.ok) syncNow();
  };
  useEffect(() => {
    // Anywhere except an Android browser: pair straight away (the Android app is offered there instead).
    if (payload && !androidBrowser && !result && !busy) void claimHere(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload]);
  if (!payload) return null;
  return (
    <Sheet open onClose={close} title={`Pair with ${payload.n}`} subtitle="One scan, no address or PIN.">
      <div className="stack lg">
        {result ? (
          <p style={{ margin: 0, color: result.ok ? 'var(--ok)' : 'var(--bad)' }}>{result.text}</p>
        ) : androidBrowser ? (
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>Use the Android app for alarms that ring even when the phone is locked, or keep using this browser.</p>
            <div className="btn-row">
              <a className="btn primary" href={encodePair('executionos://pair', payload)}>
                Open in the Android app
              </a>
              <button className="btn" disabled={busy} onClick={() => void claimHere(payload)}>
                Use in this browser
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">{busy ? 'Connecting…' : ''}</p>
        )}
        {result?.ok && installPrompt && (
          <button className="btn" onClick={() => void installPrompt?.prompt()}>
            Install app
          </button>
        )}
      </div>
    </Sheet>
  );
}
