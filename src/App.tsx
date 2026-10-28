import { MotionConfig, motion } from 'motion/react';
import { CalendarDays, ChartColumn, Clock3, Ellipsis, Gauge, GraduationCap, ListTodo, Settings2, Split } from 'lucide-react';
import { useEffect } from 'react';
import { blockAt, planFor } from './core/engine';
import { logicalDate, offsetOf } from './core/time';
import { EASE } from './components/ui';
import { FocusMode } from './overlays/FocusMode';
import { RescueSheet } from './overlays/RescueSheet';
import { BlockSheet } from './overlays/BlockSheet';
import { ProposalSheet } from './overlays/ProposalSheet';
import { OverrideSheet } from './overlays/OverrideSheet';
import { PairLinkSheet } from './screens/DevicesV2';
import { ConflictSheet } from './overlays/ConflictSheet';
import { GuardNudge, JoinWarning, LaterSheet, ProofSheet, Toasts, UrgeSheet } from './overlays/Sheets';
import { Welcome } from './overlays/Welcome';
import { WakeGate } from './overlays/WakeGate';
import { Clock } from './screens/Clock';
import { Plan } from './screens/Plan';
import { Review } from './screens/Review';
import { Rules } from './screens/Rules';
import { Settings } from './screens/Settings';
import { Today } from './screens/Today';
import { Calendar } from './screens/Calendar';
import { More } from './screens/More';
import { Study } from './screens/Study';
import { useFlag } from './state/hooks';
import { useNow, useRuntime } from './state/runtime';
import { useStore, type Tab } from './state/store';
import { useMediaQuery } from './components/ui';
import { platformLabel } from './lib/platform';

type NavItem = { id: Tab; label: string; icon: typeof Gauge; key: string; group?: string };

// The desktop rail is grouped by task (do today · look back · set up) and the number keys follow the visual order.
const V1_NAV: NavItem[] = [
  { id: 'now', label: 'Now', icon: Gauge, key: '', group: 'Daily' },
  { id: 'plan', label: 'Plan', icon: ListTodo, key: '' },
  { id: 'review', label: 'Review', icon: ChartColumn, key: '', group: 'Look back' },
  { id: 'clock', label: 'Clock', icon: Clock3, key: '', group: 'System' },
  { id: 'rules', label: 'Rules', icon: Split, key: '' },
  { id: 'settings', label: 'Settings', icon: Settings2, key: '' },
];

// v2 (flag "calendar"): the Calendar tab, Review renamed Insights, and a five-item bar on phones.
const V2_NAV: NavItem[] = [
  { id: 'now', label: 'Now', icon: Gauge, key: '', group: 'Daily' },
  { id: 'plan', label: 'Plan', icon: ListTodo, key: '' },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, key: '', group: 'Look back' },
  { id: 'review', label: 'Insights', icon: ChartColumn, key: '' },
  { id: 'clock', label: 'Clock', icon: Clock3, key: '', group: 'System' },
  { id: 'rules', label: 'Rules', icon: Split, key: '' },
  { id: 'settings', label: 'Settings', icon: Settings2, key: '' },
];
const MORE_ITEM: NavItem = { id: 'more', label: 'More', icon: Ellipsis, key: '' };
const V2_MOBILE: NavItem[] = [V2_NAV[0], V2_NAV[1], V2_NAV[2], V2_NAV[3], MORE_ITEM];

// Study OS (flag "study"): a Study tab right after Now. On phones it takes Calendar's place (Calendar moves to More).
const STUDY_ITEM: NavItem = { id: 'study', label: 'Study', icon: GraduationCap, key: '' };
const withStudy = (nav: NavItem[]) => [nav[0], STUDY_ITEM, ...nav.slice(1)];
const STUDY_MOBILE: NavItem[] = [V2_NAV[0], STUDY_ITEM, V2_NAV[1], V2_NAV[3], MORE_ITEM];
const numbered = (nav: NavItem[]) => nav.map((n, i) => ({ ...n, key: String(i + 1) }));

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
    case 'calendar':
      return <Calendar />;
    case 'more':
      return <More />;
    case 'study':
      return <Study />;
  }
}

export default function App() {
  useRuntime();
  useTheme();
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const calendarOn = useFlag('calendar');
  const studyOn = useFlag('study');
  const baseNav = calendarOn ? V2_NAV : V1_NAV;
  const NAV = numbered(studyOn ? withStudy(baseNav) : baseNav);
  const baseMobile = calendarOn ? V2_MOBILE : V1_NAV.filter((n) => n.id !== 'rules');
  const MOBILE_NAV = studyOn ? (calendarOn ? STUDY_MOBILE : withStudy(baseMobile).slice(0, 6)) : baseMobile;
  useEffect(() => {
    if (!calendarOn && (tab === 'calendar' || tab === 'more')) setTab('now');
    if (!studyOn && tab === 'study') setTab('now');
  }, [calendarOn, studyOn, tab, setTab]);
  useEffect(() => {
    // a Study session link (#study/session/<id>) from a proof opens the Study tab
    if (studyOn && location.hash.startsWith('#study/')) setTab('study');
  }, [studyOn, setTab]);
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
  }, [setTab, open, NAV]);

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
            return [
              n.group && (
                <span key={`g-${n.group}`} className="nav-group">
                  {n.group}
                </span>
              ),
              <button key={n.id} className="nav-item" aria-current={active ? 'page' : undefined} onClick={() => setTab(n.id)}>
                {active && <motion.span layoutId="nav-bg" className="nav-bg" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <Icon size={18} />
                <span>{n.label}</span>
                <kbd>{n.key}</kbd>
              </button>,
            ];
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
            const active = tab === n.id || (n.id === 'settings' && tab === 'rules') || (n.id === 'more' && ['clock', 'rules', 'settings', ...(studyOn && calendarOn ? ['calendar'] : [])].includes(tab));
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
      <BlockSheet />
      <ProposalSheet />
      <PairLinkSheet />
      <JoinWarning />
      <OverrideSheet />
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
