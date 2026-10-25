import { CircleAlert, CircleCheck, CircleDashed, Copy, ExternalLink, KeyRound, RefreshCw, Undo2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Toggle } from '../components/ui';
import { openExternal } from '../lib/platform';
import { hubRequest } from '../state/sync';
import { useStore } from '../state/store';

// Settings → AI connector (this PC only) and Settings → AI activity (every paired device).

interface Status {
  enabled: boolean;
  listening: boolean;
  port: number;
  localUrl: string;
  publicUrl: string | null;
  clients: { client: string; createdAt: number; lastUsed: number | null }[];
  tailscale: { installed: boolean; running: boolean; dnsName: string | null } | null;
  funnel: boolean | null;
  reachable: boolean | null;
  checkedAt: number | null;
  sleepOnAcMin: number | null;
  lastAiRun: { at: number; client: string; tool: string } | null;
  enableUrl?: string;
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await hubRequest(path, body ? { method: 'POST', body: JSON.stringify(body) } : {});
  const j = (await res.json()) as T & { error?: string };
  if (!res.ok && j.error) throw new Error(j.error);
  return j;
}

function Row({ name, desc, children }: { name: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div className="name">{name}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

const ago = (ms: number | null) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

export function ConnectorSection() {
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<{ client: string; token: string } | null>(null);
  const [other, setOther] = useState('chatgpt');

  const load = (check = false) =>
    call<Status>(`connector${check ? '?check=1' : ''}`)
      .then((s) => {
        setSt(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load(true);
  }, []);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      const r = await call<Status & { status?: Status; token?: string; client?: string; result?: { ok: boolean; message: string; enableUrl?: string } }>('connector', { action, ...extra });
      if (r.status) setSt({ ...r.status, enableUrl: r.result?.enableUrl });
      else setSt(r);
      if (r.token && r.client) {
        setToken({ client: r.client, token: r.token });
        try {
          await navigator.clipboard.writeText(r.token);
          toast(`Token for ${r.client} copied. Paste it into the connector settings now — it is shown only once.`, 'success');
        } catch {
          toast('Copy the token below — it is shown only once.', 'info');
        }
      }
      if (r.result) toast(r.result.message, r.result.ok ? 'success' : 'warn');
    } catch (e) {
      toast((e as Error).message, 'warn');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied.`, 'success');
    } catch {
      toast('Clipboard not available here.', 'warn');
    }
  };

  if (error) {
    return (
      <section className="card">
        <p className="muted" style={{ margin: 0 }}>
          The AI connector is managed on the PC that runs Execution OS (the Windows app or http://localhost:4747). {error}
        </p>
      </section>
    );
  }
  if (!st) return <section className="card muted">Loading…</section>;

  const light = !st.enabled ? 'off' : st.reachable ? 'ok' : st.publicUrl ? 'warn' : 'local';
  const lightText = {
    off: 'Off — nothing can reach Execution OS through the connector.',
    ok: 'Reachable from the internet (Claude web, desktop and mobile can connect).',
    warn: 'Published, but the last check could not reach it. Is Tailscale running?',
    local: 'On for this PC only (Claude Code). Publish it to use Claude on the web and phone.',
  }[light];
  const ts = st.tailscale;
  const claudeCode = `claude mcp add --transport http execution-os ${st.localUrl} --header "Authorization: Bearer ${token?.client === 'claude-code' ? token.token : '<token>'}"`;

  return (
    <div className="stack lg">
      <section className="card">
        <Row name="AI connector" desc="Lets Claude (or another MCP client) read and operate Execution OS. Small changes apply directly and can be undone; plans arrive as proposals you approve.">
          <Toggle on={st.enabled} onChange={(v) => void act(v ? 'enable' : 'disable')} label="AI connector" />
        </Row>
        <div className="row" style={{ gap: 8, fontSize: 14, marginTop: 4 }}>
          {light === 'ok' ? <CircleCheck size={16} color="var(--ok)" /> : light === 'warn' ? <CircleAlert size={16} color="var(--warn)" /> : <CircleDashed size={16} color="var(--ink-3)" />}
          <span>{lightText}</span>
          {st.enabled && (
            <button className="btn ghost sm" disabled={busy === 'check'} onClick={() => void load(true)}>
              <RefreshCw size={14} /> Check
            </button>
          )}
        </div>
        {st.lastAiRun && (
          <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
            Last AI call: {st.lastAiRun.client} · {st.lastAiRun.tool} · {ago(st.lastAiRun.at)}
          </p>
        )}
        {st.enabled && st.sleepOnAcMin !== null && st.sleepOnAcMin > 0 && st.sleepOnAcMin < 120 && (
          <p style={{ fontSize: 13, color: 'var(--warn)', margin: '8px 0 0' }}>
            This PC sleeps after {st.sleepOnAcMin} minutes on power. Claude can’t reach a sleeping PC — set “Sleep” to Never (Windows Settings → System → Power).
          </p>
        )}
      </section>

      {st.enabled && (
        <section className="card">
          <h2 className="card-title">Reach it from Claude web and mobile</h2>
          {!ts?.installed ? (
            <ol className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 14, display: 'grid', gap: 6 }}>
              <li>
                Install Tailscale (free) on this PC and sign in.{' '}
                <button className="btn ghost sm" onClick={() => openExternal('https://tailscale.com/download')}>
                  <ExternalLink size={14} /> tailscale.com/download
                </button>
              </li>
              <li>Come back here and press Check.</li>
            </ol>
          ) : !ts.running ? (
            <p className="muted" style={{ margin: 0 }}>Tailscale is installed but not signed in. Open Tailscale, sign in, then press Check.</p>
          ) : (
            <div className="stack">
              <Row name={st.publicUrl ? 'Published' : 'Not published'} desc={st.publicUrl ? 'Only the connector is public, behind your token. The sync hub (port 4747) is never published.' : 'Publishes only this connector through Tailscale Funnel on port 8443.'}>
                {st.publicUrl ? (
                  <button className="btn" disabled={!!busy} onClick={() => void act('unpublish')}>
                    Stop publishing
                  </button>
                ) : (
                  <button className="btn primary" disabled={!!busy} onClick={() => void act('publish')}>
                    {busy === 'publish' ? 'Publishing…' : 'Publish'}
                  </button>
                )}
              </Row>
              {st.enableUrl && (
                <button className="btn" onClick={() => openExternal(st.enableUrl!)}>
                  <ExternalLink size={14} /> Allow Funnel in Tailscale (one time)
                </button>
              )}
              {st.publicUrl && (
                <div className="row wrap" style={{ gap: 8 }}>
                  <code className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>{st.publicUrl}</code>
                  <button className="btn sm" onClick={() => void copy(st.publicUrl!, 'Link')}>
                    <Copy size={14} /> Copy link
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {st.enabled && (
        <section className="card">
          <h2 className="card-title">Tokens</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            One token per AI app. A new token replaces the old one for that app. Tokens are shown once and stored only as a fingerprint.
          </p>
          <div className="btn-row">
            <button className="btn primary" disabled={!!busy} onClick={() => void act('rotate', { client: 'claude' })}>
              <KeyRound size={16} /> Copy token for Claude
            </button>
            <select className="select" style={{ width: 150 }} value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="chatgpt">ChatGPT</option>
              <option value="claude-code">Claude Code</option>
              <option value="other">Other</option>
            </select>
            <button className="btn" disabled={!!busy} onClick={() => void act('rotate', { client: other })}>
              Add another client
            </button>
          </div>
          {token && (
            <div className="token-box">
              <div className="faint" style={{ fontSize: 12 }}>Token for {token.client} — shown once</div>
              <code className="mono">{token.token}</code>
              <button className="btn sm" onClick={() => void copy(token.token, 'Token')}>
                <Copy size={14} /> Copy
              </button>
            </div>
          )}
          {st.clients.length > 0 && (
            <div className="stack" style={{ marginTop: 12 }}>
              {st.clients.map((c) => (
                <div key={c.client} className="row between" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                  <span>
                    <strong>{c.client}</strong> <span className="faint">· last used {ago(c.lastUsed)}</span>
                  </span>
                  <button className="btn ghost sm danger" onClick={() => void act('revoke', { client: c.client })}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2 className="card-title">Set up Claude (once)</h2>
        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, display: 'grid', gap: 6 }}>
          <li>Turn the connector on, press Publish (Tailscale prompts you the first time).</li>
          <li>Press Copy link, then Copy token for Claude.</li>
          <li>
            In Claude: Settings → Connectors → Add custom connector. Name <strong>Execution OS</strong>, URL = the link. Under advanced, add the request header <code>Authorization</code> with
            value <code>Bearer &lt;token&gt;</code>. Save.
          </li>
          <li>In a chat, open “+” → Connectors and enable Execution OS. Set read tools to “Always allow” and write tools to “Ask”.</li>
          <li>Test: “What’s my current block in Execution OS?”</li>
        </ol>
        <div className="divider" />
        <div className="stack" style={{ gap: 6 }}>
          <strong style={{ fontSize: 14 }}>Claude Code on this PC</strong>
          <code className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{claudeCode}</code>
          <div>
            <button className="btn sm" onClick={() => void copy(claudeCode, 'Command')}>
              <Copy size={14} /> Copy command
            </button>
          </div>
        </div>
        <div className="divider" />
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'grid', gap: 4 }}>
          <li>Keep the token only in Claude — not in notes, chats or screenshots.</li>
          <li>To stop all AI access at once: switch the connector off here or in the tray menu.</li>
          <li>Every AI change is listed under AI activity with Undo.</li>
        </ul>
      </section>
    </div>
  );
}

interface Entry {
  seq: number;
  at: number;
  client: string;
  tool: string;
  ok: boolean;
  summary: string;
  changed: { key: string; r: number }[];
  undone: boolean;
}

export function ActivitySection() {
  const toast = useStore((s) => s.toast);
  const rev = useStore((s) => s.sync.rev);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Record<number, string>>({});
  const load = () =>
    call<{ entries: Entry[] }>('ai-activity')
      .then((j) => {
        setEntries(j.entries);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev]);

  if (error) return <section className="card muted">AI activity is kept on the PC. {error}</section>;
  if (!entries) return <section className="card muted">Loading…</section>;
  if (!entries.length)
    return (
      <section className="card">
        <div className="empty">
          <strong>No AI activity yet.</strong>
          <span>Every call from Claude or another connected AI app will be listed here, with Undo for changes.</span>
        </div>
      </section>
    );

  const byDay = new Map<string, Entry[]>();
  for (const e of entries) {
    const k = new Date(e.at).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  return (
    <div className="stack lg">
      {[...byDay.entries()].map(([day, list]) => (
        <section key={day} className="card">
          <h2 className="card-title">{day}</h2>
          <div className="stack" style={{ gap: 0 }}>
            {list.map((e) => (
              <div key={e.seq} className="activity-row" data-ok={e.ok}>
                <span className="mono faint" style={{ fontSize: 12 }}>
                  {new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14 }}>
                    <strong>{e.client}</strong> · <span className="mono">{e.tool}</span>
                    {!e.ok && <span style={{ color: 'var(--bad)' }}> · refused</span>}
                  </div>
                  <div className="faint" style={{ fontSize: 13 }}>{e.summary}</div>
                  {blocked[e.seq] && <div style={{ fontSize: 13, color: 'var(--warn)' }}>{blocked[e.seq]}</div>}
                </div>
                {e.ok && e.changed.length > 0 && (
                  <button
                    className="btn ghost sm"
                    disabled={e.undone}
                    onClick={async () => {
                      try {
                        const res = await hubRequest('ai-activity/undo', { method: 'POST', body: JSON.stringify({ seq: e.seq }) });
                        const j = (await res.json()) as { ok: boolean; reason?: string; blocked?: string[] };
                        if (j.ok) toast('Undone. The previous version is back on every device.', 'success');
                        else setBlocked({ ...blocked, [e.seq]: `${j.reason ?? 'Could not undo.'}${j.blocked?.length ? ` (${j.blocked.join(', ')})` : ''}` });
                        void load();
                      } catch (err) {
                        toast((err as Error).message, 'warn');
                      }
                    }}
                  >
                    <Undo2 size={14} /> {e.undone ? 'Undone' : 'Undo'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
