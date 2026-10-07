import { AnimatePresence, motion } from 'motion/react';
import { Keyboard, QrCode, ShieldAlert, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { wakeDue } from '../core/engine';
import { clockOf, fmtClock, fmtDur } from '../core/time';
import { QrScanner } from '../components/QrScanner';
import { EASE } from '../components/ui';
import { verifyWake } from '../state/actions';
import { useNow } from '../state/runtime';
import { useStore } from '../state/store';
import { audioSuspended, startAlarm, successTone, unlockAudio } from '../lib/sound';

// Wake Gate: the alarm cannot be dismissed from bed. Scan the QR card (placed where you go
// right after waking) or type its backup code. The emergency bypass needs deliberate effort.

const BYPASS_PHRASE = 'I choose to skip the wake checkpoint';

export function WakeGate() {
  const open = useStore((s) => s.overlay.wake);
  return <AnimatePresence>{open && <WakeScreen key="wake" />}</AnimatePresence>;
}

function WakeScreen() {
  const doc = useStore((s) => s.doc);
  const setOverlay = useStore((s) => s.open);
  const toast = useStore((s) => s.toast);
  const now = useNow();
  const [mode, setMode] = useState<'idle' | 'scan' | 'code' | 'bypass'>('idle');
  const [code, setCode] = useState('');
  const [phrase, setPhrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const stopRef = useRef<() => void>(() => {});
  const due = wakeDue(doc, now);
  const nowClock = clockOf((now - new Date(now).setHours(0, 0, 0, 0)) / 60000, 0);

  useEffect(() => {
    if (!doc.settings.sound) return;
    stopRef.current = startAlarm();
    const t = window.setTimeout(() => setSoundBlocked(audioSuspended()), 800);
    return () => {
      window.clearTimeout(t);
      stopRef.current();
    };
  }, [doc.settings.sound]);

  const complete = useCallback(
    (method: 'qr' | 'code' | 'bypass') => {
      stopRef.current();
      verifyWake(method);
      successTone();
      const late = due.lateMin;
      setOverlay({ wake: false });
      if (method === 'bypass') toast('Wake checkpoint bypassed. Logged honestly — it counts as late.', 'warn');
      else toast(late > doc.settings.wakeGraceMin ? `Wake complete — ${fmtDur(late)} late.` : 'Wake complete. Devotion block started.', 'success');
      if (late > doc.settings.rescueMin) {
        window.setTimeout(() => setOverlay({ rescue: true }), 600);
      }
    },
    [due.lateMin, doc.settings.wakeGraceMin, doc.settings.rescueMin, setOverlay, toast],
  );

  const onScan = useCallback(
    (text: string) => {
      if (text.trim() === `EOS-WAKE:${doc.settings.wakeCode}`) complete('qr');
      else {
        setError('That is not your wake card. Scan the printed Execution OS code.');
        setMode('idle');
      }
    },
    [complete, doc.settings.wakeCode],
  );

  return (
    <motion.div className="wake-screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }} role="alertdialog" aria-label="Wake checkpoint">
      <div className="wake-inner">
        <div className="wake-rings" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <motion.i
              key={i}
              initial={{ scale: 0.5, opacity: 0.8 }}
              animate={{ scale: 1.25, opacity: 0 }}
              transition={{ duration: 2.4, delay: i * 0.8, repeat: Infinity, ease: 'easeOut' }}
            />
          ))}
          <div className="wake-time">{fmtClock(nowClock).replace(/ (AM|PM)$/, '')}</div>
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, letterSpacing: '-0.02em' }}>Wake checkpoint</h1>
          <p style={{ margin: '6px 0 0', color: 'var(--ink-2)' }}>
            {due.lateMin > doc.settings.wakeGraceMin ? `Started ${fmtDur(due.lateMin)} ago. ` : ''}Get up, walk to your wake card, scan it.
          </p>
        </div>

        <AnimatePresence mode="wait">
          {mode === 'idle' && (
            <motion.div key="idle" className="stack" style={{ width: '100%' }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: EASE }}>
              <button
                className="btn primary lg"
                onClick={() => {
                  unlockAudio();
                  setError(null);
                  setMode('scan');
                }}
              >
                <QrCode size={18} /> Scan wake card
              </button>
              <button className="btn lg" onClick={() => setMode('code')}>
                <Keyboard size={18} /> Type backup code
              </button>
              {soundBlocked && (
                <button
                  className="btn ghost"
                  onClick={() => {
                    unlockAudio();
                    setSoundBlocked(false);
                  }}
                >
                  <Volume2 size={16} /> Enable alarm sound
                </button>
              )}
              <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setMode('bypass')}>
                Emergency bypass
              </button>
            </motion.div>
          )}
          {mode === 'scan' && (
            <motion.div key="scan" className="stack" style={{ width: '100%', justifyItems: 'center' }} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              <QrScanner onResult={onScan} />
              <button className="btn ghost" onClick={() => setMode('idle')}>
                Back
              </button>
            </motion.div>
          )}
          {mode === 'code' && (
            <motion.form
              key="code"
              className="stack"
              style={{ width: '100%' }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim().toUpperCase() === doc.settings.wakeCode) complete('code');
                else setError('Wrong code. It is printed under the QR on your wake card.');
              }}
            >
              <input
                className="input mono"
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="6-character code"
                style={{ textAlign: 'center', fontSize: 24, letterSpacing: '0.2em', height: 56 }}
                maxLength={8}
              />
              <button className="btn primary lg" type="submit" disabled={code.trim().length < 4}>
                Verify
              </button>
              <button type="button" className="btn ghost" onClick={() => setMode('idle')}>
                Back
              </button>
            </motion.form>
          )}
          {mode === 'bypass' && (
            <motion.div key="bypass" className="stack" style={{ width: '100%' }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <div className="banner" data-tone="rescue" style={{ textAlign: 'left', background: '#341a17' }}>
                <ShieldAlert size={18} />
                <div>
                  <h3>Bypass on purpose, not by reflex</h3>
                  <p style={{ margin: 0 }}>
                    Type exactly: <span className="mono">{BYPASS_PHRASE}</span>
                  </p>
                </div>
              </div>
              <input className="input" autoFocus value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={BYPASS_PHRASE} />
              <button className="btn lg" disabled={phrase.trim().toLowerCase() !== BYPASS_PHRASE.toLowerCase()} onClick={() => complete('bypass')}>
                Bypass the checkpoint
              </button>
              <button className="btn ghost" onClick={() => setMode('idle')}>
                Back
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        {error && <p style={{ color: '#ef7a6c', margin: 0, fontSize: 14 }}>{error}</p>}
      </div>
    </motion.div>
  );
}
