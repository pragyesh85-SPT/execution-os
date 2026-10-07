import { MotionConfig, motion } from 'motion/react';
import { ChartColumn, Clock3, Gauge, ListTodo, Settings2, Split } from 'lucide-react';
import { useEffect } from 'react';
import { blockAt, planFor } from './core/engine';
import { logicalDate, offsetOf } from './core/time';
import { EASE } from './components/ui';
import { FocusMode } from './overlays/FocusMode';
import { RescueSheet } from './overlays/RescueSheet';
import { ConflictSheet } from './overlays/ConflictSheet';
import { GuardNudge, LaterSheet, ProofSheet, Toasts, UrgeSheet, Welcome } from './overlays/Sheets';
import { WakeGate } from './overlays/WakeGate';
import { Clock } from './screens/Clock';
import { Plan } from './screens/Plan';
import { Review } from './screens/Review';
import { Rules } from './screens/Rules';
import { Settings } from './screens/Settings';
import { Today } from './screens/Today';
import { useNow, useRuntime } from './state/runtime';
import { useStore, type Tab } from './state/store';
import { useMediaQuery } from './components/ui';
import { platformLabel } from './lib/platform';

const NAV: { id: Tab; label: string; icon: typeof Gauge; key: string }[] = [
  { id: 'now', label: 'Now', icon: Gauge, key: '1' },
  { id: 'plan', label: 'Plan', icon: ListTodo, key: '2' },
  { id: 'clock', label: 'Clock', icon: Clock3, key: '3' },
  { id: 'review', label: 'Review', icon: ChartColumn, key: '4' },
  { id: 'rules', label: 'Rules', icon: Split, key: '5' },
  { id: 'settings', label: 'Settings', icon: Settings2, key: '6' },
];
const MOBILE_NAV = NAV.filter((n) => n.id !== 'rules');

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="12.5" fill="none" stroke="var(--ink)" strokeWidth="2.5" />
      <path d="M16 3.5 A12.5 12.5 0 0 1 28.5 16" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <line x1="16" y1="16" x2="16" y2="7.5" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.2" fill="var(--ink)" />
    </svg>
  );
}

function useTheme() {
  const theme = useStore((s) => s.doc.settings.theme);
  const doc = useStore((s) => s.doc);
  const now = useNow();
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const minute = Math.floor(now / 60_000);
  useEffect(() => {
    let dark = theme === 'dark';
    if (theme === 'auto') {
      const date = logicalDate(now, doc.settings.dayStart);
      const b = blockAt(planFor(doc, date), offsetOf(now, date, doc.settings.dayStart));
      dark = prefersDark || b?.category === 'sleep';
    }
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121110' : '#F6F4EF');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, prefersDark, minute, doc.template, doc.days]);
}

function Screen({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'now':
      return <Today />;
    case 'plan':
      return <Plan />;
    case 'clock':
      return <Clock />;
    case 'review':
      return <Review />;
    case 'rules':
      return <Rules />;
    case 'settings':
      return <Settings />;
  }
}

export default function App() {
  useRuntime();
  useTheme();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const open = useStore((s) => s.open);
  const name = useStore((s) => s.doc.settings.name);
  const motionPref = useStore((s) => s.local.motion);
  const systemReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const reduced = motionPref === 'reduced' || (motionPref === 'system' && systemReduced);
  useEffect(() => {
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  }, [reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (e.ctrlKey || e.metaKey || e.altKey || el?.closest('input, textarea, select, [contenteditable]')) return;
      if (useStore.getState().overlay.wake) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n) {
        setTab(n.id);
        return;
      }
      if (e.key.toLowerCase() === 'f') open({ focus: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTab, open]);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <MotionConfig reducedMotion={reduced ? 'always' : 'never'} transition={{ ease: EASE }}>
      <div className="shell">
        <nav className="rail" aria-label="Main">
          <div className="brand">
            <BrandMark />
            Execution OS
          </div>
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = tab === n.id;
            return (
              <button key={n.id} className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => setTab(n.id)}>
                {active && <motion.span layoutId="nav-bg" className="nav-bg" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <Icon size={18} />
                <span>{n.label}</span>
                <kbd>{n.key}</kbd>
              </button>
            );
          })}
          <div className="rail-foot">
            <span>
              {name} · {platformLabel}
            </span>
            <span>
              Press <kbd className="mono">F</kbd> for focus
            </span>
          </div>
        </nav>

        <main className="main">
          {/* Enter-only transition: the next page never waits for the previous one to finish leaving. */}
          <motion.div key={tab} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24, ease: EASE }}>
            <Screen tab={tab} />
          </motion.div>
        </main>

        <nav className="bottom-nav" aria-label="Main">
          {MOBILE_NAV.map((n) => {
            const Icon = n.icon;
            const active = tab === n.id || (n.id === 'settings' && tab === 'rules');
            return (
              <button key={n.id} aria-current={active ? 'page' : undefined} onClick={() => setTab(n.id)}>
                {active && <motion.span layoutId="bottom-dot" className="nav-dot" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
                <Icon size={20} />
                {n.label}
              </button>
            );
          })}
        </nav>
      </div>

      <FocusMode />
      <RescueSheet />
      <ProofSheet />
      <UrgeSheet />
      <LaterSheet />
      <GuardNudge />
      <ConflictSheet />
      <Welcome />
      <WakeGate />
      <Toasts />
    </MotionConfig>
  );
}
