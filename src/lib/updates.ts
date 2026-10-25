import { isAndroid, native } from './platform';

// "Check for updates" on every platform. The installed Windows app (NSIS) updates itself through
// electron-updater; the portable EXE and the Android app compare with the latest GitHub Release and
// offer the download; the web version is served by the PC hub, so it updates when the PC does.
// Offline, the check fails gracefully.

export const REPO = 'pragyesh85-SPT/execution-os';

export interface UpdateStatus {
  current: string;
  latest?: string;
  available: boolean;
  mode: 'auto' | 'download' | 'hub' | 'none';
  ready?: boolean; // Windows: downloaded, restart to install
  url?: string; // download link (APK / portable EXE) or the release page
  error?: string;
}

/** 1.10.0 > 1.9.3. Pre-release suffixes count as older than the plain version. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, '').split('-');
    return { n: main.split('.').map((x) => Number(x) || 0), pre: !!pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  return !x.pre && y.pre;
}

interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string }[];
}

export async function checkForUpdates(current = __APP_VERSION__, fetchFn: typeof fetch = fetch): Promise<UpdateStatus> {
  if (native?.checkUpdates) {
    try {
      const r = await native.checkUpdates();
      if (r.mode === 'auto') return r;
    } catch {
      /* fall back to the GitHub check */
    }
  }
  try {
    const res = await fetchFn(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 404) return { current, available: false, mode: 'none', error: 'No published release yet.' };
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    const rel = (await res.json()) as Release;
    const latest = rel.tag_name.replace(/^v/, '');
    const available = newer(latest, current);
    const asset = (re: RegExp) => rel.assets.find((a) => re.test(a.name))?.browser_download_url;
    if (isAndroid) return { current, latest, available, mode: 'download', url: asset(/\.apk$/) ?? rel.html_url };
    if (native) return { current, latest, available, mode: 'download', url: asset(/portable\.exe$/) ?? rel.html_url };
    return { current, latest, available, mode: 'hub', url: rel.html_url };
  } catch (e) {
    return { current, available: false, mode: 'none', error: navigator.onLine === false ? 'You are offline. Try again when connected.' : `Could not check: ${(e as Error).message}` };
  }
}
