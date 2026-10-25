import { AnimatePresence, motion } from 'motion/react';
import { Bell, Bot, Clock3, ScanLine, Smartphone, UserRound } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { CATEGORY_META } from '../core/defaults';
import { clockOf, fmtClock, fmtDur, offsetOf } from '../core/time';
import { Check, EASE, Field, Sheet, Toggle } from '../components/ui';
import { bypassWake, today, updateSettings } from '../state/actions';
import { useFlag } from '../state/hooks';
import { useStore } from '../state/store';
import { hubRequest } from '../state/sync';
import { requestNotifications } from '../lib/notify';
import { isCapacitor, isElectron, native } from '../lib/platform';
import { unlockAudio } from '../lib/sound';
import { ScanPcSheet } from '../screens/DevicesV2';

// First-run wizard: (1) name and day start, (2) the master clock's protected minimums,
// (3) connect a phone, (4) the optional AI connector, (5) Start with Windows + notifications.
// Every step can be revisited later from Settings → About → "Run the welcome wizard again".

const STEPS = [
  { title: 'You', icon: UserRound },
  { title: 'Your clock', icon: Clock3 },
  { title: 'Phone', icon: Smartphone },
  { title: 'AI', icon: Bot },
  { title: 'Alerts', icon: Bell },
] as const;

export function Welcome() {
  const onboarded = useStore((s) => s.doc.settings.onboarded);
  // First run until the (synced) settings say onboarded; or on purpose from Settings → About.
  const show = useStore((s) => s.overlay.welcome && (!onboarded || !!s.overlay.welcomeAgain));
  const settings = useStore((s) => s.doc.settings);
  const template = useStore((s) => s.doc.template);
  const sync = useStore((s) => s.sync);
  const local = useStore((s) => s.local);
  const setOpen = useStore((s) => s.open);
  const setTab = useStore((s) => s.setTab);
  const qrPairing = useFlag('qrPairing');
  const [step, setStep] = useState(0);
  const [name, setName] = useState(settings.name);
  const [dayStart, setDayStart] = useState(settings.dayStart);
  const [wake, setWake] = useState(settings.wakeGate);
  const [protectIit, setProtectIit] = useState(settings.protect.iit ?? 120);
  const [protectDev, setProtectDev] = useState(settings.protect.devotion ?? 120);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [qr, setQr] = useState('');
  const [scan, setScan] = useState(false);
  const isHubPc = isElectron || (sync.hub === 'same-origin' && ['localhost', '127.0.0.1'].includes(location.hostname));

  useEffect(() => {
    if (!show) return;
    setStep(0);
    setName(settings.name);
    setDayStart(settings.dayStart);
    setWake(settings.wakeGate);
    void native?.getAutostart().then(setAuto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  useEffect(() => {
    if (step !== 2 || !isHubPc || !qrPairing) return;
    const load = () =>
      hubRequest('pair/start', { method: 'POST', body: '{}' })
        .then((r) => r.json() as Promise<{ qrText: string }>)
        .then((j) => QRCode.toDataURL(j.qrText, { margin: 1, width: 260 }))
        .then(setQr)
        .catch(() => setQr(''));
    void load();
    const t = window.setInterval(load, 4 * 60_000);
    return () => window.clearInterval(t);
  }, [step, isHubPc, qrPairing]);

  const sleep = template.blocks.find((b) => b.category === 'sleep');

  const finish = async (thenTab?: 'clock' | 'settings') => {
    unlockAudio();
    await requestNotifications().catch(() => false);
    const missedToday = offsetOf(Date.now(), today(), dayStart) > settings.wakeGraceMin;
    updateSettings({
      name: name.trim() || 'PJ',
      wakeGate: wake,
      dayStart,
      protect: { ...settings.protect, iit: protectIit, devotion: protectDev },
      onboarded: true,
      startedOn: settings.startedOn ?? today(),
    });
    // Do not ring a wake alarm for a morning that already passed before the app was installed.
    if (!onboarded && wake && missedToday) bypassWake(today());
    setOpen({ welcome: false, welcomeAgain: false });
    if (thenTab) setTab(thenTab);
  };

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  return (
    <Sheet
      open={show}
      onClose={() => setOpen({ welcome: false, welcomeAgain: false })}
      dismissable={onboarded}
      title="Execution OS"
      subtitle="Given what has actually happened today, what is the single best thing to do now?"
      footer={
        <>
          {step > 0 && (
            <button className="btn ghost" onClick={back}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="btn primary" onClick={next}>
              {step === 2 || step === 3 ? 'Skip / next' : 'Next'}
            </button>
          ) : (
            <button className="btn primary" onClick={() => void finish()}>
              {onboarded ? 'Save' : 'Start'}
            </button>
          )}
        </>
      }
    >
      <div className="wizard-steps" role="list">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <button key={s.title} role="listitem" className="wizard-step" data-on={i === step} data-done={i < step} onClick={() => setStep(i)}>
              <Icon size={14} /> {s.title}
            </button>
          );
        })}
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2, ease: EASE }} className="stack lg" style={{ marginTop: 16 }}>
          {step === 0 && (
            <>
              <div className="welcome-steps">
                {[
                  ['Protect four things', 'Sleep → Devotion → IIT → Founder. Meals, care and breaks live around them.'],
                  ['One mission per block', 'Not “study” — “Finish Assignment 3, Q1–Q5”.'],
                  ['Drift is expected', 'Late? Rescue rebuilds the rest of the day around your pins.'],
                  ['Proof, not presence', 'At the end of each focus block, record what actually got done.'],
                ].map(([t, d], i) => (
                  <div key={t} className="welcome-step">
                    <span className="n">{i + 1}</span>
                    <div>
                      <strong>{t}</strong>
                      <div className="muted" style={{ fontSize: 14 }}>
                        {d}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <Field label="What should Execution OS call you?">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Your day starts at" hint="Usually the end of your sleep. Times before it belong to the previous day.">
                <select className="select mono" value={dayStart} onChange={(e) => setDayStart(Number(e.target.value))}>
                  {Array.from({ length: 13 }, (_, i) => 120 + i * 30).map((m) => (
                    <option key={m} value={m}>
                      {fmtClock(m)}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="row" style={{ fontSize: 14 }}>
                <Check on={wake} onChange={() => setWake(!wake)} label="Wake Gate" />
                Use the Wake Gate (print your QR card from Settings → Wake Gate)
              </label>
            </>
          )}

          {step === 1 && (
            <>
              <p className="muted" style={{ margin: 0 }}>
                The master clock decides <em>when</em>. Rescue and AI never move your anchors and never let these minimums fall.
              </p>
              <dl className="kv">
                <dt>Sleep</dt>
                <dd className="mono">{sleep ? `${fmtClock(sleep.start)} – ${fmtClock((sleep.start + sleep.dur) % 1440)} (${fmtDur(sleep.dur)})` : 'not set'}</dd>
                <dt>Anchors</dt>
                <dd>{template.blocks.filter((b) => b.fixed).map((b) => `${b.title} ${fmtClock(b.start)}`).join(' · ') || 'none'}</dd>
              </dl>
              <div className="form-grid">
                <Field label={`${CATEGORY_META.iit.label} protected minimum`}>
                  <select className="select mono" value={protectIit} onChange={(e) => setProtectIit(Number(e.target.value))}>
                    {[0, 30, 60, 90, 120, 150, 180].map((m) => (
                      <option key={m} value={m}>
                        {m ? fmtDur(m) : 'Off'}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`${CATEGORY_META.devotion.label} protected minimum`}>
                  <select className="select mono" value={protectDev} onChange={(e) => setProtectDev(Number(e.target.value))}>
                    {[0, 60, 120, 180, 240, 300].map((m) => (
                      <option key={m} value={m}>
                        {m ? fmtDur(m) : 'Off'}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => void finish('clock')}>
                Finish and edit the full clock now
              </button>
              <span className="faint" style={{ fontSize: 12 }}>
                Current day starts at {fmtClock(clockOf(0, dayStart))}.
              </span>
            </>
          )}

          {step === 2 && (
            <>
              {isHubPc ? (
                qrPairing && qr ? (
                  <div className="qr-card">
                    <img src={qr} alt="Pairing QR code" style={{ width: 200, height: 200 }} />
                    <div className="muted" style={{ fontSize: 14 }}>
                      Scan with the phone camera (or the Android app → Settings → Devices &amp; sync → Scan PC). One scan pairs it — no address, no PIN. You can do this any time from Settings → Devices &amp; sync.
                    </div>
                  </div>
                ) : (
                  <p className="muted">Connect a phone any time from Settings → Devices &amp; sync.</p>
                )
              ) : local.syncToken || sync.status === 'online' ? (
                <p style={{ margin: 0, color: 'var(--ok)' }}>This device is connected to {local.hubName || 'your PC'}.</p>
              ) : (
                <div className="stack">
                  <p className="muted" style={{ margin: 0 }}>Open Execution OS on your PC → Settings → Devices &amp; sync, then scan its QR code.</p>
                  {(isCapacitor || window.isSecureContext) && (
                    <div>
                      <button className="btn primary" onClick={() => setScan(true)}>
                        <ScanLine size={16} /> Scan PC
                      </button>
                    </div>
                  )}
                  <ScanPcSheet open={scan} onClose={() => setScan(false)} />
                </div>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <p style={{ margin: 0 }}>
                Optional: connect Claude (the AI you already use) to Execution OS. Then you can say “plan my day” or “rescue my day” in any Claude chat, and approve the result here.
              </p>
              <p className="muted" style={{ margin: 0 }}>
                It stays off until you switch it on, works through a private token, and every AI change can be undone.
              </p>
              <div>
                <button
                  className="btn"
                  onClick={() => {
                    try {
                      localStorage.setItem('eos.settings.section', 'connector');
                    } catch {
                      /* ignore */
                    }
                    void finish('settings');
                  }}
                >
                  <Bot size={16} /> Finish and open AI connector settings
                </button>
              </div>
            </>
          )}

          {step === 4 && (
            <>
              {isElectron && auto !== null && (
                <div className="setting">
                  <div>
                    <div className="name">Start with Windows</div>
                    <div className="desc">Starts minimised to the tray, so the wake alarm, Focus Guard and sync are always running.</div>
                  </div>
                  <Toggle on={auto} onChange={(v) => void native!.setAutostart(v).then(setAuto)} label="Start with Windows" />
                </div>
              )}
              <div className="setting">
                <div>
                  <div className="name">Notifications</div>
                  <div className="desc">Block changes, the wake alarm and proposals. Press Start to allow them.</div>
                </div>
                <Bell size={18} />
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </Sheet>
  );
}
