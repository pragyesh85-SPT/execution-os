import { AnimatePresence, animate, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { CATEGORY_META } from '../core/defaults';
import type { Category, DayState } from '../core/types';

export const EASE = [0.22, 1, 0.36, 1] as const;

export const catColor = (c: Category) => `var(--cat-${c})`;

export function useMediaQuery(q: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return match;
}

// ---------- sheet (dialog on desktop, bottom sheet on phones) ----------

export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissable?: boolean;
}) {
  const { open, onClose, title, subtitle, children, footer, wide, dismissable = true } = props;
  const mobile = useMediaQuery('(max-width: 640px)');
  const labelId = useId();
  useEffect(() => {
    if (!open || !dismissable) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, dismissable, onClose]);

  return (
    <AnimatePresence propagate>
      {open && (
        <>
          <motion.div
            key="backdrop"
            className="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={dismissable ? onClose : undefined}
          />
          <div key="sheet-wrap" className="sheet-wrap">
          <motion.div
            key="sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelId}
            className={`sheet${wide ? ' wide' : ''}`}
            initial={mobile ? { y: '100%' } : { opacity: 0, scale: 0.96, y: 14 }}
            animate={mobile ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
            exit={mobile ? { y: '100%' } : { opacity: 0, scale: 0.97, y: 8 }}
            transition={mobile ? { type: 'spring', damping: 34, stiffness: 360 } : { duration: 0.22, ease: EASE }}
            drag={mobile && dismissable ? 'y' : false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 110 || info.velocity.y > 600) onClose();
            }}
          >
            <div className="sheet-handle" />
            <div className="sheet-head">
              <div>
                <h2 id={labelId}>{title}</h2>
                {subtitle && <p>{subtitle}</p>}
              </div>
              {dismissable && (
                <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
                  <X size={18} />
                </button>
              )}
            </div>
            <div className="sheet-body">{children}</div>
            {footer && <div className="sheet-foot">{footer}</div>}
          </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}

// ---------- inputs ----------

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className="toggle" data-on={on} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <motion.span className="knob" animate={{ x: on ? 16 : 0 }} transition={{ type: 'spring', stiffness: 600, damping: 34 }} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, id }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {value === o.value && <motion.span layoutId={`seg-${id}`} className="seg-bg" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Check({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <motion.button type="button" className="check" data-on={on} aria-pressed={on} aria-label={label} onClick={onChange} whileTap={{ scale: 0.85 }}>
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <motion.path
          d="M2.5 7.5 L5.5 10.5 L11.5 3.5"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={false}
          animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
          transition={{ duration: 0.22, ease: EASE }}
        />
      </svg>
    </motion.button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function CatChip({ category }: { category: Category }) {
  return (
    <span className="chip">
      <span className="dot" style={{ background: catColor(category) }} />
      {CATEGORY_META[category].short}
    </span>
  );
}

// ---------- numbers ----------

function Digit({ d }: { d: string }) {
  return (
    <span className="digit">
      <AnimatePresence initial={false}>
        <motion.span
          key={d}
          initial={{ y: '-70%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '70%', opacity: 0 }}
          transition={{ duration: 0.28, ease: EASE }}
        >
          {d}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/** "01:37:22" with each digit rolling when it changes. */
export function RollingDigits({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`digits ${className ?? ''}`} aria-label={text} role="timer">
      {text.split('').map((ch, i) =>
        ch === ':' ? (
          <span key={i} className="digit-sep" aria-hidden="true">
            :
          </span>
        ) : (
          <Digit key={i} d={ch} />
        ),
      )}
    </span>
  );
}

export function CountUp({ value, format = (v: number) => String(Math.round(v)) }: { value: number; format?: (v: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  useEffect(() => {
    const c = animate(prev.current, value, {
      duration: 0.9,
      ease: EASE,
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = format(v);
      },
    });
    prev.current = value;
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return <span ref={ref}>{format(prev.current)}</span>;
}

// ---------- status ----------

const STATE_LABEL: Record<DayState, string> = { on_track: 'On track', drifting: 'Drifting', rescue: 'Rescue' };

export function StatusPill({ state }: { state: DayState }) {
  return (
    <motion.span layout className="status" data-state={state} transition={{ duration: 0.25, ease: EASE }}>
      <span className="pulse" />
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={state} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {STATE_LABEL[state]}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="bar">
      <motion.i
        style={{ background: color }}
        initial={{ scaleX: 0 }}
        animate={{ scaleX: Math.max(0, Math.min(1, value)) }}
        transition={{ duration: 0.8, ease: EASE }}
      />
    </div>
  );
}

/** Stagger children in on mount. */
export const listStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.045 } },
};
export const itemRise = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE } },
};
