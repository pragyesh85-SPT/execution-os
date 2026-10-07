import { Capacitor } from '@capacitor/core';

export interface EosNative {
  platform: 'electron';
  onWake: (cb: () => void) => () => void;
  onGuard: (cb: (info: { source: string; title: string }) => void) => () => void;
  getAutostart: () => Promise<boolean>;
  setAutostart: (on: boolean) => Promise<boolean>;
  show: () => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  openExtensionFolder: () => Promise<string>;
  hubInfo: () => Promise<HubInfo & { running: boolean; watcher: boolean }>;
  openDataFolder: () => Promise<void>;
}

export interface HubInfo {
  pin: string | null;
  urls: string[];
  endpoints: { url: string; kind: 'wifi' | 'tailscale' }[];
  dbFile: string | null;
  backupDir: string | null;
  backups: string[];
  stats: { records: number; versions: number; rev: number } | null;
}

declare global {
  interface Window {
    eosNative?: EosNative;
  }
}

export const native: EosNative | undefined = typeof window !== 'undefined' ? window.eosNative : undefined;
export const isElectron = !!native;
export const isCapacitor = Capacitor.isNativePlatform();
export const isAndroid = Capacitor.getPlatform() === 'android';

export const platformLabel = isElectron ? 'Windows app' : isAndroid ? 'Android app' : 'Web app';

/** True when this page is being served by an Execution OS hub (same-origin API available). */
export function servedOverHttp(): boolean {
  return !isCapacitor && (location.protocol === 'http:' || location.protocol === 'https:');
}

export function openExternal(url: string) {
  if (native) void native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
