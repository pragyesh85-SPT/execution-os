import { create } from 'zustand';
import { normalizeDoc } from '../core/merge';
import type { Doc } from '../core/types';
import type { AiConfig } from '../lib/ai';
import type { Conflict } from '../core/sync';

export type Tab = 'now' | 'plan' | 'clock' | 'review' | 'rules' | 'settings';

/** Preferences that stay on this device only (never synced). */
export interface LocalPrefs {
  aiMode: 'manual' | 'api';
  ai: AiConfig;
  syncUrl: string;
  syncPin: string;
  githubToken: string;
  deviceName: string;
  motion: 'full' | 'system' | 'reduced';
}

export interface SyncInfo {
  status: 'local' | 'connecting' | 'online' | 'offline' | 'pin';
  hub: 'same-origin' | 'remote' | null;
  lastAt?: number;
  error?: string;
  rev: number;
  pending: number; // changes on this device waiting for the PC
  lastUploaded?: number; // how many changes the last cycle uploaded
}

export interface Toast {
  id: number;
  text: string;
  tone?: 'info' | 'success' | 'warn';
  action?: { label: string; run: () => void };
}

export interface Overlays {
  focus: boolean;
  wake: boolean;
  rescue: boolean;
  proof?: { date: string; blockId: string };
  guard?: { source: string; title: string };
  urge: boolean;
  welcome: boolean;
  later: boolean;
  conflicts: boolean;
}

interface Store {
  doc: Doc;
  ver: number;
  local: LocalPrefs;
  sync: SyncInfo;
  conflicts: Conflict[];
  tab: Tab;
  overlay: Overlays;
  toasts: Toast[];
  update: (recipe: (d: Doc, now: number) => void) => void;
  replaceDoc: (doc: Doc) => void;
  setConflicts: (c: Conflict[]) => void;
  setLocal: (patch: Partial<LocalPrefs>) => void;
  setSync: (patch: Partial<SyncInfo>) => void;
  setTab: (tab: Tab) => void;
  open: (patch: Partial<Overlays>) => void;
  toast: (text: string, tone?: Toast['tone'], action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
}

const DOC_KEY = 'eos.doc.v1';
const LOCAL_KEY = 'eos.local.v1';
const CONFLICTS_KEY = 'eos.conflicts.v1';

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const defaultLocal: LocalPrefs = {
  aiMode: 'manual',
  ai: { provider: 'anthropic', apiKey: '', model: 'claude-opus-5-5', baseUrl: '' },
  syncUrl: '',
  syncPin: '',
  githubToken: '',
  deviceName: '',
  motion: 'full',
};

const initialDoc = normalizeDoc(readJson<Doc>(DOC_KEY));
const initialLocal: LocalPrefs = { ...defaultLocal, ...(readJson<LocalPrefs>(LOCAL_KEY) ?? {}) };
initialLocal.ai = { ...defaultLocal.ai, ...(initialLocal.ai ?? {}) };

let toastSeq = 1;

export const useStore = create<Store>((set, get) => ({
  doc: initialDoc,
  ver: 0,
  local: initialLocal,
  sync: { status: 'local', hub: null, rev: 0, pending: 0 },
  conflicts: readJson<Conflict[]>(CONFLICTS_KEY) ?? [],
  tab: (readJson<Tab>('eos.tab') as Tab) ?? 'now',
  overlay: { focus: false, wake: false, rescue: false, urge: false, welcome: !initialDoc.settings.onboarded, later: false, conflicts: false },
  toasts: [],
  update: (recipe) =>
    set((s) => {
      const d = structuredClone(s.doc);
      recipe(d, Date.now());
      return { doc: d, ver: s.ver + 1 };
    }),
  replaceDoc: (doc) => set({ doc }),
  setConflicts: (conflicts) => {
    set({ conflicts });
    try {
      localStorage.setItem(CONFLICTS_KEY, JSON.stringify(conflicts));
    } catch {
      /* ignore */
    }
  },
  setLocal: (patch) => {
    const local = { ...get().local, ...patch };
    set({ local });
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
    } catch {
      /* storage full or blocked */
    }
  },
  setSync: (patch) => set((s) => ({ sync: { ...s.sync, ...patch } })),
  setTab: (tab) => {
    set({ tab });
    try {
      localStorage.setItem('eos.tab', JSON.stringify(tab));
    } catch {
      /* ignore */
    }
  },
  open: (patch) => set((s) => ({ overlay: { ...s.overlay, ...patch } })),
  toast: (text, tone = 'info', action) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone, action }] }));
    window.setTimeout(() => get().dismissToast(id), action ? 7000 : 4200);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// Persist the doc locally (debounced) — the app works fully offline.
let saveTimer: number | undefined;
useStore.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(DOC_KEY, JSON.stringify(useStore.getState().doc));
    } catch {
      /* ignore */
    }
  }, 300);
});

export const getDoc = () => useStore.getState().doc;
