import type { BlockDef, Category, Doc, Rule, Settings, TemplateDoc } from './types';

export const CATEGORY_META: Record<
  Category,
  { label: string; short: string; color: string; colorDark: string; tracked: boolean }
> = {
  sleep: { label: 'Sleep', short: 'Sleep', color: '#4C5A86', colorDark: '#8A9AD0', tracked: false },
  devotion: { label: 'Devotion', short: 'Devotion', color: '#C98A0B', colorDark: '#EBB547', tracked: true },
  iit: { label: 'IIT Jodhpur', short: 'IIT', color: '#1F6FB2', colorDark: '#5CA8EC', tracked: true },
  founder: { label: 'Founder', short: 'Founder', color: '#2E7D4F', colorDark: '#5FC08A', tracked: true },
  meal: { label: 'Meal', short: 'Meal', color: '#B4563A', colorDark: '#E08C70', tracked: false },
  care: { label: 'Care / Workout', short: 'Care', color: '#2C8C88', colorDark: '#5CC6C1', tracked: true },
  rest: { label: 'Rest', short: 'Rest', color: '#8A857B', colorDark: '#A8A397', tracked: false },
  buffer: { label: 'Buffer', short: 'Buffer', color: '#A39E92', colorDark: '#7D786E', tracked: false },
  entertainment: { label: 'Entertainment', short: 'Fun', color: '#B0457A', colorDark: '#E07AAE', tracked: false },
};

export const CATEGORY_ORDER: Category[] = [
  'sleep',
  'devotion',
  'iit',
  'founder',
  'meal',
  'care',
  'rest',
  'buffer',
  'entertainment',
];

const t = (h: number, m = 0) => h * 60 + m;

export const DEFAULT_BLOCKS: BlockDef[] = [
  { id: 'b-sleep', title: 'Sleep', category: 'sleep', start: t(21), dur: 420, fixed: true, focus: false, minMinutes: 420, priority: 1 },
  { id: 'b-temple', title: 'Temple / devotion', category: 'devotion', start: t(4), dur: 240, fixed: false, focus: false, minMinutes: 120, priority: 1 },
  { id: 'b-rest', title: 'Rest', category: 'rest', start: t(8), dur: 30, fixed: false, focus: false, minMinutes: 0, priority: 5 },
  { id: 'b-meal1', title: 'Meal', category: 'meal', start: t(8, 30), dur: 60, fixed: false, focus: false, minMinutes: 30, priority: 2 },
  { id: 'b-plan', title: 'Buffer + daily planning', category: 'buffer', start: t(9, 30), dur: 30, fixed: false, focus: false, minMinutes: 10, priority: 3 },
  { id: 'b-iit', title: 'IIT Jodhpur — protected study', category: 'iit', start: t(10), dur: 120, fixed: false, focus: true, minMinutes: 120, priority: 1 },
  { id: 'b-founder', title: 'Founder deep work', category: 'founder', start: t(12), dur: 300, fixed: false, focus: true, minMinutes: 120, priority: 3 },
  { id: 'b-meal2', title: 'Meal', category: 'meal', start: t(17), dur: 60, fixed: false, focus: false, minMinutes: 30, priority: 2 },
  { id: 'b-admin', title: 'Founder / admin', category: 'founder', start: t(18), dur: 60, fixed: false, focus: true, minMinutes: 0, priority: 4 },
  { id: 'b-aarti', title: 'Aarti / devotion', category: 'devotion', start: t(19), dur: 60, fixed: true, focus: false, minMinutes: 60, priority: 1 },
  { id: 'b-care', title: 'Daily care / workout', category: 'care', start: t(20), dur: 60, fixed: false, focus: false, minMinutes: 30, priority: 3 },
];

export function randomCode(len = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function defaultSettings(now = Date.now()): Settings {
  return {
    id: 'settings',
    u: now,
    name: 'PJ',
    dayStart: t(4),
    protect: { iit: 120, devotion: 120 },
    targets: { iit: 120, founder: 360, devotion: 300, care: 60 },
    driftMin: 10,
    rescueMin: 20,
    autoRescue: false,
    wakeGate: true,
    wakeCode: randomCode(),
    wakeGraceMin: 10,
    entBudgetMin: 300,
    theme: 'auto',
    focusBlock: [
      'instagram.com',
      'netflix.com',
      'youtube.com',
      'reddit.com',
      'x.com',
      'twitter.com',
      'facebook.com',
      'primevideo.com',
      'hotstar.com',
      'jiocinema.com',
    ],
    focusAllow: ['github.com', 'mail.google.com', 'web.whatsapp.com', 'claude.ai', 'chatgpt.com'],
    focusKeywords: ['YouTube', 'Netflix', 'Instagram', 'Reddit', 'Prime Video', 'Hotstar', 'JioCinema', 'Facebook'],
    sound: true,
    notifyBlocks: true,
    onboarded: false,
  };
}

export function defaultTemplate(now = Date.now()): TemplateDoc {
  return { id: 'template', u: now, blocks: DEFAULT_BLOCKS.map((b) => ({ ...b })) };
}

export function defaultRules(now = Date.now()): Record<string, Rule> {
  const list: Rule[] = [
    {
      id: 'r-iit-start',
      u: now,
      enabled: true,
      trigger: { type: 'block_start', category: 'iit' },
      action: { type: 'focus' },
      cue: 'IF the IIT block starts THEN open the mission and turn Focus Guard on.',
      createdAt: now,
    },
    {
      id: 'r-iit-missed',
      u: now,
      enabled: true,
      trigger: { type: 'block_missed', category: 'iit', minutes: 20 },
      action: { type: 'rescue' },
      cue: 'IF I miss more than 20 minutes of a study block THEN activate Rescue Mode.',
      createdAt: now,
    },
    {
      id: 'r-urge',
      u: now,
      enabled: true,
      trigger: { type: 'urge' },
      action: { type: 'save_later' },
      cue: 'IF I feel like watching YouTube during a focus block THEN save it to Later instead of opening it.',
      createdAt: now,
    },
    {
      id: 'r-outcomes',
      u: now,
      enabled: true,
      trigger: { type: 'outcomes_done' },
      action: { type: 'unlock_ent' },
      cue: 'IF I complete the day’s three outcomes THEN optional entertainment becomes available.',
      createdAt: now,
    },
    {
      id: 'r-founder-start',
      u: now,
      enabled: true,
      trigger: { type: 'block_start', category: 'founder' },
      action: { type: 'notify', message: 'Founder block started. One mission, phone face down.' },
      cue: 'IF a Founder block starts THEN remind me: one mission, phone face down.',
      createdAt: now,
    },
  ];
  return Object.fromEntries(list.map((r) => [r.id, r]));
}

// Defaults are stamped u = 0 so that any real edit on any device always wins the merge,
// and a brand-new phone never overwrites the hub's settings with its own fresh defaults.
export function emptyDoc(now = 0): Doc {
  return {
    settings: defaultSettings(now),
    template: defaultTemplate(now),
    days: {},
    sessions: {},
    proofs: {},
    wake: {},
    tasks: {},
    rules: defaultRules(now),
    distractions: {},
    later: {},
    reviews: {},
  };
}
