import type { Settings } from './types';

// Feature flags (synced in settings.features). Every v2 feature checks its flag, so the fastest
// rollback is to switch it off in Settings → Labs: the feature hides and stops new writes,
// and nothing already saved is deleted.

export type FeatureKey =
  | 'pins'
  | 'rescueV2'
  | 'proposals'
  | 'mcp'
  | 'qrPairing'
  | 'goals'
  | 'calendar'
  | 'analytics'
  | 'coaching'
  | 'imports'
  | 'mcpApps'
  | 'quickOverride';

/** Default for settings records that never set the flag. A feature defaults on once its release has shipped. */
export const FEATURE_DEFAULTS: Record<FeatureKey, boolean> = {
  pins: true, // shipped in v1.1.0
  rescueV2: true, // shipped in v1.1.0
  proposals: true, // shipped in v1.1.0
  mcp: true, // shipped in v1.2.0 (the connector itself stays off until switched on)
  qrPairing: true, // shipped in v1.3.0
  goals: true, // shipped in v1.4.0
  calendar: true, // shipped in v1.4.0
  analytics: true, // shipped in v1.5.0
  coaching: true, // shipped in v1.5.0
  imports: true, // shipped in v1.5.0
  mcpApps: true, // shipped in v2.0.0
  quickOverride: true, // shipped in v2.0.0
};

export const FEATURE_INFO: Record<FeatureKey, { label: string; desc: string }> = {
  pins: { label: 'Pinned blocks', desc: 'Pin any block to its clock time and add your own blocks to a day. Rescue never moves a pin.' },
  rescueV2: { label: 'Rescue v2', desc: 'Rescue strategies (balanced, protect study, ship, light day), a reason for every change, and “apply for the week”.' },
  proposals: { label: 'Proposals', desc: 'Rescue and AI plans arrive as a reviewable proposal instead of changing the day directly.' },
  mcp: { label: 'AI connector', desc: 'Lets Claude (or another MCP client) read and operate Execution OS through a private, token-protected connector.' },
  qrPairing: { label: 'One-scan pairing', desc: 'Pair a phone by scanning one QR code — no address or PIN typing. Device tokens can be revoked.' },
  goals: { label: 'Targets', desc: 'Year → month → week → day targets with roll-up and on-track / behind colouring.' },
  calendar: { label: 'Calendar', desc: 'Calendar tab with day / week / month views and the targets panel.' },
  analytics: { label: 'Analytics', desc: 'Plan-versus-reality metrics over 7, 28 or 90 days on the Insights tab.' },
  coaching: { label: 'Coach', desc: 'A weekly grade the AI cannot round up, the evidence behind it and one IF → THEN change.' },
  imports: { label: 'Imports & Join links', desc: 'Import classes as pinned blocks with a Join button and a reminder before they start.' },
  mcpApps: { label: 'Cards in chat', desc: 'Interactive proposal cards inside Claude (MCP Apps). Text replies stay as a fallback.' },
  quickOverride: { label: 'Quick override', desc: '“I’m doing something else” inside a block: swap, borrow 15/30 minutes, or mark drift honestly.' },
};

export const FEATURE_KEYS = Object.keys(FEATURE_DEFAULTS) as FeatureKey[];

export const isOn = (s: Pick<Settings, 'features'>, k: FeatureKey): boolean => s.features?.[k] ?? FEATURE_DEFAULTS[k];
