import { CalendarDays, ChevronRight, Clock3, Settings2, Split } from 'lucide-react';
import { useFlag } from '../state/hooks';
import { useStore } from '../state/store';

// Phones show five tabs; the rest live here.

export function More() {
  const setTab = useStore((s) => s.setTab);
  // With Study OS on, the phone bar shows Study instead of Calendar, so Calendar lives here.
  const studyOn = useFlag('study');
  const items = [
    ...(studyOn ? [{ id: 'calendar' as const, label: 'Calendar', desc: 'Day, week and month views with your targets', icon: CalendarDays }] : []),
    { id: 'clock' as const, label: 'Clock', desc: 'The master clock: your default 24 hours', icon: Clock3 },
    { id: 'rules' as const, label: 'Rules', desc: 'IF → THEN rules decided in advance', icon: Split },
    { id: 'settings' as const, label: 'Settings', desc: 'Devices, AI connector, health, Labs', icon: Settings2 },
  ];
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>More</h1>
        </div>
      </header>
      <section className="card" style={{ padding: 0 }}>
        {items.map((i) => {
          const Icon = i.icon;
          return (
            <button key={i.id} className="more-item" onClick={() => setTab(i.id)}>
              <Icon size={18} />
              <span className="grow">
                <strong>{i.label}</strong>
                <span className="faint">{i.desc}</span>
              </span>
              <ChevronRight size={16} />
            </button>
          );
        })}
      </section>
    </div>
  );
}
