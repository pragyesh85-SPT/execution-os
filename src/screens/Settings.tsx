import { motion } from 'motion/react';
import { Bell, Download, Eye, EyeOff, FolderOpen, Printer, RefreshCw, Upload, Volume2 } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { randomCode } from '../core/defaults';
import type { Settings as S } from '../core/types';
import { fmtDur } from '../core/time';
import { EASE, Field, Segmented, Sheet, Toggle } from '../components/ui';
import { clearHistory, exportJson, importJson, resetEverything, updateSettings } from '../state/actions';
import { syncNow, testHub } from '../state/sync';
import { useStore, type LocalPrefs } from '../state/store';
import { PROVIDERS, testAi, type Provider } from '../lib/ai';
import { exactAlarmStatus, notificationPermission, notify, openExactAlarmSettings, requestNotifications } from '../lib/notify';
import { isAndroid, isCapacitor, isElectron, native, platformLabel, type HubInfo } from '../lib/platform';
import { startAlarm, unlockAudio } from '../lib/sound';
import { Rules } from './Rules';

const SECTIONS = [
  ['profile', 'Day & targets'],
  ['wake', 'Wake Gate'],
  ['focus', 'Focus Guard'],
  ['ai', 'AI'],
  ['devices', 'Devices & sync'],
  ['notify', 'Notifications'],
  ['integrations', 'Integrations'],
  ['rules', 'IF → THEN rules'],
  ['data', 'Data'],
  ['about', 'About'],
] as const;
type Section = (typeof SECTIONS)[number][0];

export function Settings() {
  const [section, setSection] = useState<Section>(() => {
    try {
      return (localStorage.getItem('eos.settings.section') as Section) || 'profile';
    } catch {
      return 'profile';
    }
  });
  const go = (s: Section) => {
    setSection(s);
    try {
      localStorage.setItem('eos.settings.section', s);
    } catch {
      /* ignore */
    }
  };
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Synced settings apply to every device. AI keys and hub address stay on this device.</p>
        </div>
      </header>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([id, label]) => (
            <button key={id} aria-current={section === id} onClick={() => go(id)}>
              {label}
            </button>
          ))}
        </nav>
        <motion.div key={section} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}>
          {section === 'profile' && <ProfileSection />}
          {section === 'wake' && <WakeSection />}
          {section === 'focus' && <FocusSection />}
          {section === 'ai' && <AiSection />}
          {section === 'devices' && <DevicesSection />}
          {section === 'notify' && <NotifySection />}
          {section === 'integrations' && <IntegrationsSection />}
          {section === 'rules' && <Rules />}
          {section === 'data' && <DataSection />}
          {section === 'about' && <AboutSection />}
        </motion.div>
      </div>
    </div>
  );
}

function Row({ name, desc, children }: { name: string; desc?: ReactNode; children: ReactNode }) {
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

function MinutesSelect({ value, onChange, options }: { value: number; onChange: (v: number) => void; options: number[] }) {
  return (
    <select className="select mono" style={{ width: 120 }} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {options.map((m) => (
        <option key={m} value={m}>
          {m === 0 ? 'Off' : fmtDur(m)}
        </option>
      ))}
    </select>
  );
}

function useSettings(): [S, (p: Partial<S>) => void] {
  const s = useStore((st) => st.doc.settings);
  return [s, updateSettings];
}

// ---------------- profile ----------------

function ProfileSection() {
  const [s, set] = useSettings();
  return (
    <section className="card">
      <Row name="Your name" desc="Used by the planner and the reviews.">
        <input className="input" style={{ width: 200 }} defaultValue={s.name} onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && set({ name: e.target.value.trim() })} />
      </Row>
      <Row name="Theme" desc="Auto follows your device, and turns dark during your sleep block.">
        <Segmented
          id="theme"
          value={s.theme}
          onChange={(v) => set({ theme: v })}
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </Row>
      <Row name="IIT protected minimum" desc="Rescue Mode never lets IIT fall below this per day.">
        <MinutesSelect value={s.protect.iit ?? 0} onChange={(v) => set({ protect: { ...s.protect, iit: v } })} options={[0, 30, 60, 90, 120, 150, 180]} />
      </Row>
      <Row name="Devotion protected minimum">
        <MinutesSelect value={s.protect.devotion ?? 0} onChange={(v) => set({ protect: { ...s.protect, devotion: v } })} options={[0, 60, 120, 180, 240, 300]} />
      </Row>
      <Row name="Daily targets" desc="What a full day looks like — used by the day score.">
        <div className="stack" style={{ gap: 6, justifyItems: 'end' }}>
          {(['iit', 'founder', 'devotion', 'care'] as const).map((c) => (
            <label key={c} className="row" style={{ gap: 8, fontSize: 13 }}>
              <span className="muted">{c === 'iit' ? 'IIT' : c === 'care' ? 'Care' : c[0].toUpperCase() + c.slice(1)}</span>
              <MinutesSelect value={s.targets[c] ?? 0} onChange={(v) => set({ targets: { ...s.targets, [c]: v } })} options={[0, 30, 60, 90, 120, 180, 240, 300, 360, 420, 480]} />
            </label>
          ))}
        </div>
      </Row>
      <Row name="Drifting after" desc="How long a focus block may go unstarted before the status turns amber.">
        <MinutesSelect value={s.driftMin} onChange={(v) => set({ driftMin: v })} options={[5, 10, 15, 20]} />
      </Row>
      <Row name="Rescue after" desc="When it turns red and offers to rebuild the day.">
        <MinutesSelect value={s.rescueMin} onChange={(v) => set({ rescueMin: v })} options={[15, 20, 30, 45, 60]} />
      </Row>
      <Row name="Open Rescue Mode automatically" desc="Otherwise it waits for you to tap “Rebuild my day”.">
        <Toggle on={s.autoRescue} onChange={(v) => set({ autoRescue: v })} label="Auto rescue" />
      </Row>
      <Row name="Weekly entertainment budget" desc="Planned movies/videos draw from this; unplanned distraction does too.">
        <MinutesSelect value={s.entBudgetMin} onChange={(v) => set({ entBudgetMin: v })} options={[0, 60, 120, 180, 240, 300, 360, 480, 600]} />
      </Row>
      <MotionRow />
      <Row name="Sounds" desc="Block-change chime and completion tones.">
        <Toggle on={s.sound} onChange={(v) => set({ sound: v })} label="Sounds" />
      </Row>
    </section>
  );
}

function MotionRow() {
  const motionPref = useStore((st) => st.local.motion);
  const setLocal = useStore((st) => st.setLocal);
  return (
    <Row name="Motion" desc="Full motion everywhere, or follow this device's “reduce animations” setting. Stored on this device.">
      <Segmented
        id="motion"
        value={motionPref}
        onChange={(v) => setLocal({ motion: v })}
        options={[
          { value: 'full', label: 'Full' },
          { value: 'system', label: 'System' },
          { value: 'reduced', label: 'Reduced' },
        ]}
      />
    </Row>
  );
}

// ---------------- wake ----------------

function WakeSection() {
  const [s, set] = useSettings();
  const [qr, setQr] = useState('');
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    QRCode.toDataURL(`EOS-WAKE:${s.wakeCode}`, { margin: 1, width: 420, color: { dark: '#1c1b19', light: '#ffffff' } }).then(setQr);
  }, [s.wakeCode]);
  return (
    <div className="stack lg">
      <section className="card">
        <Row name="Wake Gate" desc="At the end of your sleep block, the alarm can only be stopped by scanning this QR code away from your bed.">
          <Toggle on={s.wakeGate} onChange={(v) => set({ wakeGate: v })} label="Wake Gate" />
        </Row>
        <Row name="On-time grace" desc="Verifying within this window counts as on time.">
          <MinutesSelect value={s.wakeGraceMin} onChange={(v) => set({ wakeGraceMin: v })} options={[5, 10, 15, 20, 30]} />
        </Row>
        <Row name="Test the alarm" desc="Plays the escalating bell for 6 seconds.">
          <button
            className="btn"
            disabled={testing}
            onClick={() => {
              unlockAudio();
              setTesting(true);
              const stop = startAlarm();
              window.setTimeout(() => {
                stop();
                setTesting(false);
              }, 6000);
            }}
          >
            <Volume2 size={16} /> {testing ? 'Ringing…' : 'Test sound'}
          </button>
        </Row>
      </section>
      <section className="card">
        <h2 className="card-title">Your wake card</h2>
        <div className="qr-card">
          {qr && <img src={qr} alt="Wake QR code" />}
          <div className="stack" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 13 }}>Backup code (type it if the camera fails)</span>
            <span className="code-big">{s.wakeCode}</span>
            <span className="faint" style={{ fontSize: 13 }}>Print it and stick it where you go right after waking — the temple corner, the bathroom mirror.</span>
          </div>
        </div>
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn" onClick={() => window.print()}>
            <Printer size={16} /> Print card
          </button>
          <button className="btn ghost" onClick={() => set({ wakeCode: randomCode() })}>
            <RefreshCw size={16} /> New code
          </button>
        </div>
        <div className="print-area" style={{ display: 'none' }}>
          {qr && <img src={qr} alt="" style={{ width: 320, height: 320 }} />}
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 28, letterSpacing: '0.2em' }}>{s.wakeCode}</div>
          <div>Execution OS · Wake checkpoint</div>
        </div>
      </section>
    </div>
  );
}

// ---------------- focus guard ----------------

function ListEditor({ label, hint, value, onSave }: { label: string; hint: string; value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return (
    <Field label={label} hint={hint}>
      <textarea
        className="textarea mono"
        style={{ fontSize: 13 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const list = text
            .split(/[\n,]/)
            .map((x) => x.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
            .filter(Boolean);
          if (list.join() !== value.join()) onSave(list);
        }}
      />
    </Field>
  );
}

function KeywordEditor({ value, onSave }: { value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(value.join('\n'));
  return (
    <Field label="Window titles to watch (Windows app)" hint="If the foreground window title contains one of these during focus, Execution OS steps in.">
      <textarea
        className="textarea mono"
        style={{ fontSize: 13 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onSave(text.split('\n').map((x) => x.trim()).filter(Boolean))}
      />
    </Field>
  );
}

function FocusSection() {
  const [s, set] = useSettings();
  const [watcher, setWatcher] = useState<boolean | null>(null);
  useEffect(() => {
    void native?.hubInfo().then((i) => setWatcher(i.watcher));
  }, []);
  return (
    <div className="stack lg">
      <section className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          During IIT and Founder blocks, distraction becomes harder to reach. Work tools stay open. Entertainment blocks and paused guard are exempt.
        </p>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <ListEditor label="Blocked during focus" hint="One domain per line." value={s.focusBlock} onSave={(v) => set({ focusBlock: v })} />
          <ListEditor label="Always allowed" hint="Wins over the block list." value={s.focusAllow} onSave={(v) => set({ focusAllow: v })} />
        </div>
      </section>
      <section className="card">
        <h2 className="card-title">Where the guard runs</h2>
        <div className="stack">
          <Row name="Browser extension (Chrome / Edge)" desc="Blocks the listed sites during focus and offers “Save for later”. Load it once as an unpacked extension (steps in the README).">
            {isElectron ? (
              <button className="btn" onClick={() => void native?.openExtensionFolder()}>
                <FolderOpen size={16} /> Open folder
              </button>
            ) : (
              <span className="chip">execution-os/extension</span>
            )}
          </Row>
          <Row name="Windows window watcher" desc={isElectron ? `Watches the foreground window during focus. ${watcher ? 'Active right now.' : 'Starts automatically when a focus block begins.'}` : 'Available in the Windows app.'}>
            <span className="chip">{isElectron ? 'built in' : 'Windows app only'}</span>
          </Row>
          <Row name="Android" desc="Version 1 nudges with notifications and Focus Mode. System-level app blocking needs an accessibility service — planned for a later version.">
            <span className="chip">nudges</span>
          </Row>
        </div>
        <div className="divider" />
        <KeywordEditor value={s.focusKeywords} onSave={(v) => set({ focusKeywords: v })} />
      </section>
    </div>
  );
}

// ---------------- AI ----------------

function AiSection() {
  const local = useStore((s) => s.local);
  const setLocal = useStore((s) => s.setLocal);
  const toast = useStore((s) => s.toast);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const prov = PROVIDERS.find((p) => p.id === local.ai.provider) ?? PROVIDERS[0];
  const setAi = (p: Partial<LocalPrefs['ai']>) => setLocal({ ai: { ...local.ai, ...p } });

  return (
    <div className="stack lg">
      <section className="card">
        <Row name="Planning mode" desc="Manual: you (or the built-in smart fill / copy-paste flow) decide missions. API: the AI plans directly from this device.">
          <Segmented
            id="ai-mode"
            value={local.aiMode}
            onChange={(v) => setLocal({ aiMode: v })}
            options={[
              { value: 'manual', label: 'Manual' },
              { value: 'api', label: 'API key' },
            ]}
          />
        </Row>
        {local.aiMode === 'manual' && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Manual mode still gives you three paths on the Plan page: type missions yourself, <strong>Smart fill</strong> (built-in, no AI), or <strong>Copy prompt → paste reply</strong> with any chat AI.
          </p>
        )}
      </section>
      {local.aiMode === 'api' && (
        <section className="card">
          <div className="stack">
            <Field label="Provider">
              <select
                className="select"
                value={local.ai.provider}
                onChange={(e) => {
                  const p = PROVIDERS.find((x) => x.id === e.target.value)!;
                  setAi({ provider: p.id as Provider, model: p.defaultModel });
                  setResult(null);
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Model" hint={prov.models.length ? `Suggestions: ${prov.models.join(', ')}` : 'Exact model id from your provider'}>
              <input className="input mono" list="model-list" value={local.ai.model} onChange={(e) => setAi({ model: e.target.value.trim() })} />
              <datalist id="model-list">
                {prov.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            {local.ai.provider === 'compatible' && (
              <Field label="Base URL" hint={prov.hint}>
                <input className="input mono" value={local.ai.baseUrl} onChange={(e) => setAi({ baseUrl: e.target.value.trim() })} placeholder="https://openrouter.ai/api/v1" />
              </Field>
            )}
            <Field label="API key" hint={`${prov.hint} Stored only on this device — never synced to the hub or other devices.`}>
              <div className="row">
                <input
                  className="input mono grow"
                  type={show ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  value={local.ai.apiKey}
                  onChange={(e) => setAi({ apiKey: e.target.value.trim() })}
                  placeholder="Paste your key"
                />
                <button className="btn icon" aria-label={show ? 'Hide key' : 'Show key'} onClick={() => setShow(!show)}>
                  {show ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </Field>
            <div className="btn-row">
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setResult(null);
                  try {
                    const text = await testAi(local.ai);
                    setResult({ ok: true, text: `Connected — model replied: “${text}”` });
                  } catch (err) {
                    setResult({ ok: false, text: (err as Error).message });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? 'Testing…' : 'Test connection'}
              </button>
              {local.ai.apiKey && (
                <button
                  className="btn ghost danger"
                  onClick={() => {
                    setAi({ apiKey: '' });
                    toast('Key removed from this device.');
                  }}
                >
                  Remove key
                </button>
              )}
            </div>
            {result && <p style={{ margin: 0, color: result.ok ? 'var(--ok)' : 'var(--bad)', fontSize: 14 }}>{result.text}</p>}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------- devices ----------------

function DevicesSection() {
  const local = useStore((s) => s.local);
  const setLocal = useStore((s) => s.setLocal);
  const sync = useStore((s) => s.sync);
  const conflicts = useStore((s) => s.conflicts.length);
  const openOverlay = useStore((s) => s.open);
  const toast = useStore((s) => s.toast);
  const [info, setInfo] = useState<HubInfo | null>(null);
  const [qr, setQr] = useState('');
  const [url, setUrl] = useState(local.syncUrl);
  const [pin, setPin] = useState(local.syncPin);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadInfo = () => {
    if (native) {
      void native.hubInfo().then((i) => i.running && setInfo(i));
    } else if (sync.hub === 'same-origin' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      void fetch('./api/info')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: HubInfo | null) => j && setInfo(j));
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadInfo, [sync.hub, sync.rev]);

  const anywhere = info?.endpoints.find((e) => e.kind === 'tailscale');
  const home = info?.endpoints.filter((e) => e.kind === 'wifi') ?? [];
  const phoneUrl = anywhere?.url ?? home[0]?.url;
  useEffect(() => {
    if (phoneUrl) void QRCode.toDataURL(phoneUrl, { margin: 1, width: 300 }).then(setQr);
  }, [phoneUrl]);

  const lastSync = sync.lastAt ? new Date(sync.lastAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—';
  const statusText =
    sync.status === 'online'
      ? `Connected to the PC · last sync ${lastSync}`
      : sync.status === 'offline'
        ? 'PC not reachable right now — working offline on this device'
        : sync.status === 'pin'
          ? 'PC found — pairing PIN needed'
          : sync.status === 'connecting'
            ? 'Connecting to the PC…'
            : 'Not connected to a PC yet — everything stays on this device';

  return (
    <div className="stack lg">
      <section className="card">
        <h2 className="card-title">Sync status</h2>
        <Row name={platformLabel} desc={statusText}>
          <span className="chip">
            <span
              className="sync-dot"
              style={{ background: sync.status === 'online' ? 'var(--ok)' : sync.status === 'local' || sync.status === 'offline' ? 'var(--ink-3)' : 'var(--warn)' }}
            />
            {sync.status === 'online' ? 'online' : sync.status}
          </span>
        </Row>
        <Row name="Waiting to upload" desc="Changes made on this device that the PC has not received yet. They upload automatically the moment the PC is reachable.">
          <span className="mono" style={{ fontSize: 18 }}>
            {sync.pending}
          </span>
        </Row>
        <Row name="Clashes to decide" desc="Same item edited differently on two devices. Nothing is overwritten until you choose.">
          {conflicts ? (
            <button className="btn primary sm" onClick={() => openOverlay({ conflicts: true })}>
              Review {conflicts}
            </button>
          ) : (
            <span className="mono" style={{ fontSize: 18 }}>
              0
            </span>
          )}
        </Row>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={syncNow}>
            <RefreshCw size={14} /> Sync now
          </button>
        </div>
        <div className="divider" />
        <ul className="muted" style={{ margin: 0, paddingLeft: 18, fontSize: 14, display: 'grid', gap: 4 }}>
          <li>Your PC is the database. Every device keeps a full copy so it works with the PC off.</li>
          <li>PC off or out of range → changes are saved on the device and queued.</li>
          <li>PC back → the queue uploads by itself; edits from other devices download.</li>
          <li>Different fields changed on two devices → merged automatically. Same field → you decide.</li>
        </ul>
      </section>

      {info && (
        <section className="card">
          <h2 className="card-title">This PC is the database</h2>
          <dl className="kv">
            <dt>Database file</dt>
            <dd className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {info.dbFile}
            </dd>
            <dt>Records</dt>
            <dd className="mono">{info.stats?.records ?? '—'}</dd>
            <dt>Versions kept</dt>
            <dd className="mono">{info.stats?.versions ?? '—'} (every change, from every device)</dd>
            <dt>Backups</dt>
            <dd>{info.backups.length ? `${info.backups.length} daily · latest ${info.backups[0].replace('execution-os-', '').replace('.db', '')}` : 'none yet'}</dd>
          </dl>
          <div className="btn-row" style={{ marginTop: 12 }}>
            {native && (
              <button className="btn sm" onClick={() => void native!.openDataFolder()}>
                <FolderOpen size={14} /> Open data folder
              </button>
            )}
            <button
              className="btn ghost sm"
              onClick={async () => {
                try {
                  await fetch(native ? 'http://localhost:4747/api/backup' : './api/backup', { method: 'POST' });
                  toast('Backup for today is saved.', 'success');
                  loadInfo();
                } catch {
                  toast('Backup failed.', 'warn');
                }
              }}
            >
              Back up now
            </button>
          </div>
        </section>
      )}

      {info && (
        <section className="card">
          <h2 className="card-title">Connect your phone</h2>
          <div className="qr-card">
            {qr ? <img src={qr} alt="Hub address QR" /> : <span />}
            <div className="stack" style={{ gap: 8 }}>
              {anywhere && (
                <div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    Anywhere (Tailscale) — recommended
                  </div>
                  <span className="mono" style={{ fontSize: 16 }}>
                    {anywhere.url}
                  </span>
                </div>
              )}
              {home.map((e) => (
                <div key={e.url}>
                  <div className="faint" style={{ fontSize: 12 }}>
                    Home Wi-Fi only
                  </div>
                  <span className="mono" style={{ fontSize: 16 }}>
                    {e.url}
                  </span>
                </div>
              ))}
              <div className="faint" style={{ fontSize: 12 }}>
                Pairing PIN
              </div>
              <span className="code-big">{info.pin}</span>
            </div>
          </div>
          <ol className="muted" style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 14, display: 'grid', gap: 4 }}>
            {anywhere ? (
              <li>
                Install <strong>Tailscale</strong> on the phone and sign in with the same account as this PC (free). Then the address above works from anywhere, not just at home.
              </li>
            ) : (
              <li>For access outside home, install Tailscale (free) on this PC and the phone.</li>
            )}
            <li>Android app: Settings → Devices &amp; sync → enter the address and PIN.</li>
            <li>iPhone: open the address in Safari → Share → Add to Home Screen (needs the PC on).</li>
            <li>Keep the PC app running: Settings → Notifications → Start with Windows.</li>
          </ol>
        </section>
      )}

      {sync.hub === 'same-origin' && sync.status === 'pin' && (
        <section className="card">
          <h2 className="card-title">Pair this device</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            This page comes from your PC. Enter the 6-digit pairing PIN shown on the PC (Settings → Devices &amp; sync).
          </p>
          <div className="row">
            <input className="input mono" style={{ maxWidth: 180 }} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="6 digits" inputMode="numeric" />
            <button
              className="btn primary"
              disabled={pin.trim().length < 6}
              onClick={() => {
                setLocal({ syncPin: pin.trim() });
                syncNow();
                setMsg({ ok: true, text: 'PIN saved. Syncing…' });
              }}
            >
              Pair
            </button>
          </div>
          {msg && <p style={{ margin: '12px 0 0', fontSize: 14, color: msg.ok ? 'var(--ok)' : 'var(--bad)' }}>{msg.text}</p>}
        </section>
      )}

      {sync.hub !== 'same-origin' && !info && (
        <section className="card">
          <h2 className="card-title">Connect to your PC</h2>
          <div className="form-grid">
            <Field label="PC address" hint="Shown on the PC under Settings → Devices & sync. Use the Tailscale one to sync from anywhere.">
              <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://100.x.x.x:4747" inputMode="url" />
            </Field>
            <Field label="Pairing PIN">
              <input className="input mono" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="6 digits" inputMode="numeric" />
            </Field>
            <Field label="Name of this device" hint="Shown in the PC's change history.">
              <input className="input" defaultValue={local.deviceName} placeholder={platformLabel} onBlur={(e) => setLocal({ deviceName: e.target.value.trim() })} />
            </Field>
          </div>
          <div className="btn-row" style={{ marginTop: 12 }}>
            <button
              className="btn primary"
              disabled={!url.trim()}
              onClick={async () => {
                const r = await testHub(url.trim(), pin.trim());
                setMsg({ ok: r.ok, text: r.message });
                if (r.ok) {
                  setLocal({ syncUrl: url.trim(), syncPin: pin.trim() });
                  syncNow();
                }
              }}
            >
              Connect
            </button>
            {local.syncUrl && (
              <button
                className="btn ghost"
                onClick={() => {
                  setLocal({ syncUrl: '', syncPin: '' });
                  setUrl('');
                  setPin('');
                  setMsg({ ok: true, text: 'Disconnected. This device now works on its own.' });
                }}
              >
                Disconnect
              </button>
            )}
          </div>
          {msg && <p style={{ margin: '12px 0 0', fontSize: 14, color: msg.ok ? 'var(--ok)' : 'var(--bad)' }}>{msg.text}</p>}
        </section>
      )}
    </div>
  );
}

// ---------------- notifications ----------------

function NotifySection() {
  const [s, set] = useSettings();
  const [perm, setPerm] = useState<string>('…');
  const [exact, setExact] = useState<string | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const refresh = () => {
    void notificationPermission().then(setPerm);
    void exactAlarmStatus().then(setExact);
  };
  useEffect(() => {
    refresh();
    void native?.getAutostart().then(setAuto);
  }, []);
  return (
    <section className="card">
      <Row name="Notification permission" desc={`Currently: ${perm}`}>
        <button
          className="btn"
          onClick={async () => {
            await requestNotifications();
            refresh();
          }}
        >
          <Bell size={16} /> Allow
        </button>
      </Row>
      <Row name="Announce every block change" desc={isAndroid ? 'Scheduled in Android ahead of time, so they fire even when the app is closed.' : 'Shown while the app is running (the Windows app keeps running in the tray).'}>
        <Toggle on={s.notifyBlocks} onChange={(v) => set({ notifyBlocks: v })} label="Block notifications" />
      </Row>
      {isAndroid && (
        <Row name="Exact alarms" desc={`Android must allow exact alarms for the 4 AM wake to fire on time. Status: ${exact ?? 'unknown'}.`}>
          <button className="btn" onClick={() => void openExactAlarmSettings().then(refresh)}>
            Open setting
          </button>
        </Row>
      )}
      {isElectron && auto !== null && (
        <Row name="Start with Windows" desc="Starts minimised to the tray so the wake alarm and Focus Guard are always running.">
          <Toggle on={auto} onChange={(v) => void native!.setAutostart(v).then(setAuto)} label="Start with Windows" />
        </Row>
      )}
      <Row name="Send a test notification">
        <button className="btn ghost" onClick={() => void notify('Execution OS', 'Notifications are working.')}>
          Send test
        </button>
      </Row>
    </section>
  );
}

// ---------------- integrations ----------------

function IntegrationsSection() {
  const [s, set] = useSettings();
  const local = useStore((st) => st.local);
  const setLocal = useStore((st) => st.setLocal);
  return (
    <section className="card">
      <h2 className="card-title">GitHub — automatic proof of work</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        When you record proof for a Founder block, commits and pull requests made during that block are detected automatically.
      </p>
      <div className="form-grid">
        <Field label="GitHub username" hint="Synced to all devices.">
          <input className="input mono" defaultValue={s.githubUser ?? ''} onBlur={(e) => set({ githubUser: e.target.value.trim() || undefined })} placeholder="your-handle" />
        </Field>
        <Field label="Token (optional)" hint="Only needed for private repos. Stays on this device.">
          <input className="input mono" type="password" value={local.githubToken} onChange={(e) => setLocal({ githubToken: e.target.value.trim() })} placeholder="github_pat_…" />
        </Field>
      </div>
      <div className="divider" />
      <h2 className="card-title">Coming next</h2>
      <p className="muted" style={{ margin: 0 }}>
        Gmail (course emails) and Google Calendar need a Google sign-in app registered under your account — tell me when you want them and I will wire them into the planner context.
      </p>
    </section>
  );
}

// ---------------- data ----------------

function DataSection() {
  const toast = useStore((s) => s.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState<null | 'history' | 'all'>(null);
  const exportData = async () => {
    const json = exportJson();
    if (isCapacitor) {
      try {
        await navigator.clipboard.writeText(json);
        toast('Backup copied to the clipboard. Paste it into a note or email to yourself.', 'success');
      } catch {
        toast('Clipboard not available on this device.', 'warn');
      }
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `execution-os-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <section className="card">
      <Row name="Export backup" desc="Everything synced: plans, sessions, proof, tasks, rules, settings. Not your API key.">
        <button className="btn" onClick={exportData}>
          <Download size={16} /> Export JSON
        </button>
      </Row>
      <Row name="Restore backup" desc="Imported records win and spread to every connected device.">
        <>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                importJson(await f.text());
                toast('Backup restored.', 'success');
              } catch (err) {
                toast(`Could not read that file: ${(err as Error).message}`, 'warn');
              }
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={16} /> Import JSON
          </button>
        </>
      </Row>
      <Row name="Clear history" desc="Removes tracked days, sessions, proof and reviews. Keeps clock, rules, tasks and settings.">
        <button className="btn danger" onClick={() => setConfirm('history')}>
          Clear history
        </button>
      </Row>
      <Row name="Reset everything" desc="Back to the recommended clock and default settings on every device.">
        <button className="btn danger" onClick={() => setConfirm('all')}>
          Reset
        </button>
      </Row>
      <Sheet
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm === 'all' ? 'Reset everything?' : 'Clear all history?'}
        subtitle="This syncs to every connected device. Export a backup first if you might want it back."
        footer={
          <>
            <button className="btn ghost" onClick={() => setConfirm(null)}>
              Keep my data
            </button>
            <button
              className="btn primary"
              onClick={() => {
                if (confirm === 'all') resetEverything();
                else clearHistory();
                setConfirm(null);
                toast(confirm === 'all' ? 'Everything reset.' : 'History cleared.', 'success');
              }}
            >
              {confirm === 'all' ? 'Reset everything' : 'Clear history'}
            </button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {confirm === 'all' ? 'Plans, history, tasks, rules and settings return to defaults.' : 'Your clock, rules, tasks and settings stay as they are.'}
        </p>
      </Sheet>
    </section>
  );
}

// ---------------- about ----------------

function AboutSection() {
  return (
    <div className="stack lg">
      <section className="card">
        <dl className="kv">
          <dt>Version</dt>
          <dd className="mono">1.0.0</dd>
          <dt>Running as</dt>
          <dd>{platformLabel}</dd>
          <dt>Principle</dt>
          <dd>Rules engine = authority. AI = strategist. Never carry lateness forward block by block.</dd>
        </dl>
      </section>
      <section className="card">
        <h2 className="card-title">Built on this research</h2>
        <div className="stack" style={{ fontSize: 14 }}>
          <div>
            <strong>Implementation intentions</strong> — Gollwitzer &amp; Sheeran (2006). IF→THEN rules.
          </div>
          <div>
            <strong>How habits form</strong> — Lally et al. (2010). 18–254 days; one miss does not matter → adherence, not streaks.
          </div>
          <div>
            <strong>The nature of procrastination</strong> — Steel (2007). Reduce ambiguity and delay → one concrete mission per block.
          </div>
          <div>
            <strong>Blocking distractions</strong> — Mark et al. (2017). Environmental blocking → Focus Guard.
          </div>
          <div>
            <strong>Task switching costs</strong> — Rubinstein, Meyer &amp; Evans (2001). Long single-purpose blocks.
          </div>
          <div>
            <strong>Does time management work?</strong> — Aeon, Faber &amp; Panaccio (2021).
          </div>
          <div>
            <strong>Sleep duration</strong> — AASM consensus. Sleep is a protected, fixed anchor.
          </div>
        </div>
      </section>
    </div>
  );
}
