import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startHub, type Hub } from '../server/hub';

// Windows desktop shell for Execution OS.
// The EXE *is* the hub: it runs the sync server, so your phone connects to this PC.
// It also owns the two things a browser tab cannot do reliably:
//   1. the 4 AM wake alarm (window jumps to the front, stays on top until verified)
//   2. the Windows Focus Guard watcher (notices Netflix/YouTube in the foreground during focus)

const PORT = Number(process.env.EOS_PORT ?? 4747);
const BASE = `http://localhost:${PORT}`;
const startHidden = process.argv.includes('--hidden');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let hub: Hub | null = null;
let quitting = false;
let trayHintShown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.setAppUserModelId('com.pragyesh.executionos');
  app.whenReady().then(boot);
}

// Small startup log so problems on a user's machine can be diagnosed: %APPDATA%\execution-os\main.log
function log(msg: string) {
  try {
    appendFileSync(join(app.getPath('userData'), 'main.log'), `${new Date().toISOString()} ${msg}
`);
  } catch {
    /* ignore */
  }
}

function iconPath(name: string): string {
  return join(app.getAppPath(), 'dist', name);
}

async function boot() {
  log(`boot v${app.getVersion()} hidden=${startHidden}`);
  Menu.setApplicationMenu(null);
  const dbFile = process.env.EOS_DB ?? join(app.getPath('userData'), 'execution-os.db');
  const legacyJson = process.env.EOS_DB ? undefined : join(app.getPath('userData'), 'execution-os.json');
  try {
    hub = await startHub({ port: PORT, dbFile, legacyJson, distDir: join(app.getAppPath(), 'dist'), log });
    log('hub started');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    log(`hub failed: ${e.code ?? ''} ${e.message}`);
    if (e.code !== 'EADDRINUSE') {
      dialog.showErrorBox('Execution OS', `Could not start the local hub:\n${e.message}`);
    }
    // Port busy = the stand-alone hub is already running; this window simply connects to it.
  }
  createWindow();
  createTray();
  setInterval(pollFocus, 5000);
  pollFocus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: '#F6F4EF',
    title: 'Execution OS',
    icon: nativeImage.createFromPath(iconPath('icon-512.png')),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // timers must keep running while minimised to tray
      autoplayPolicy: 'no-user-gesture-required', // the 4 AM alarm must be able to sound
    },
  });
  win.loadURL(BASE);
  win.once('ready-to-show', () => {
    log('ready-to-show');
    if (!startHidden) win?.show();
  });
  // Safety net: never leave the user with an invisible app if the first paint signal is missed.
  setTimeout(() => {
    if (!startHidden && win && !win.isVisible()) {
      log('fallback show');
      win.show();
    }
  }, 4000);
  win.webContents.on('did-finish-load', () => log('did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    log(`did-fail-load ${code} ${desc}`);
    setTimeout(() => win?.loadURL(BASE), 1500);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    log(`render-process-gone ${d.reason}`);
    setTimeout(() => win?.reload(), 1000);
  });
  win.webContents.on('console-message', (e) => {
    const m = e as unknown as { level?: string | number; message?: string };
    if (m.level === 'error' || m.level === 3) log(`console: ${m.message}`);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'Execution OS is still running',
        body: 'Alarms, sync and Focus Guard stay active in the tray. Right-click the tray icon to quit.',
      }).show();
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath('icon-192.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Execution OS');
  tray.on('click', showWindow);
  refreshTray(null);
}

function refreshTray(status: string | null) {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status ?? 'Execution OS', enabled: false },
      { type: 'separator' },
      { label: 'Open Execution OS', click: showWindow },
      { label: 'Open in browser', click: () => shell.openExternal(BASE) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          stopWatcher();
          void (hub?.close() ?? Promise.resolve()).then(() => app.quit());
        },
      },
    ]),
  );
}

// ---------------- focus + wake polling ----------------

interface FocusInfo {
  active: boolean;
  until: number | null;
  block: { title: string; category: string } | null;
  mission: string | null;
  wakeDue: boolean;
  keywords?: string[];
}

let lastFocus: FocusInfo | null = null;
let alarmOn = false;

async function pollFocus() {
  try {
    const res = await fetch(`${BASE}/api/focus`);
    const info = (await res.json()) as FocusInfo;
    lastFocus = info;
    refreshTray(info.block ? `Now: ${info.block.title}${info.active ? ' · Focus on' : ''}` : null);

    if (info.wakeDue && !alarmOn) {
      alarmOn = true;
      showWindow();
      win?.setAlwaysOnTop(true, 'screen-saver');
      win?.flashFrame(true);
      win?.webContents.send('eos:wake');
    } else if (!info.wakeDue && alarmOn) {
      alarmOn = false;
      win?.setAlwaysOnTop(false);
      win?.flashFrame(false);
    }

    if (info.active) startWatcher();
    else stopWatcher();
  } catch {
    // hub not reachable yet
  }
}

// ---------------- Windows foreground watcher ----------------

const WATCH_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class EosFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
while ($true) {
  $h = [EosFg]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][EosFg]::GetWindowText($h, $sb, 512)
  [Console]::Out.WriteLine($sb.ToString())
  [Console]::Out.Flush()
  Start-Sleep -Seconds 3
}`;

let watcher: ChildProcessWithoutNullStreams | null = null;
let hitSource: string | null = null;
let hitStart = 0;
let lastNudge = 0;

function startWatcher() {
  if (watcher || process.platform !== 'win32') return;
  watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WATCH_SCRIPT], {
    windowsHide: true,
  });
  let buf = '';
  watcher.stdout.setEncoding('utf8');
  watcher.stdout.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) onForeground(line.trim());
  });
  watcher.on('exit', () => {
    watcher = null;
  });
}

function stopWatcher() {
  if (watcher) {
    watcher.kill();
    watcher = null;
  }
  endHit();
}

function onForeground(title: string) {
  if (!title || title.includes('Execution OS')) return endHit();
  const keywords = lastFocus?.keywords ?? [];
  const match = keywords.find((k) => k && title.toLowerCase().includes(k.toLowerCase()));
  if (!match) return endHit();
  const now = Date.now();
  if (hitSource !== match) {
    endHit();
    hitSource = match;
    hitStart = now;
  }
  // 15 seconds of grace (alt-tab accidents), then friction.
  if (now - hitStart > 15_000 && now - lastNudge > 120_000) {
    lastNudge = now;
    showWindow();
    win?.webContents.send('eos:guard', { source: match, title: title.slice(0, 120) });
  }
}

function endHit() {
  if (hitSource && hitStart) {
    const minutes = (Date.now() - hitStart) / 60_000;
    if (minutes >= 1) {
      void fetch(`${BASE}/api/distraction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: Math.round(minutes), source: hitSource }),
      }).catch(() => {});
    }
  }
  hitSource = null;
  hitStart = 0;
}

// ---------------- IPC ----------------

ipcMain.handle('eos:get-autostart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('eos:set-autostart', (_e, on: boolean) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});
ipcMain.handle('eos:show', () => showWindow());
ipcMain.handle('eos:open-external', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle('eos:extension-folder', () => {
  const packaged = join(process.resourcesPath, 'extension');
  const dev = join(app.getAppPath(), 'extension');
  const folder = existsSync(packaged) ? packaged : dev;
  void shell.openPath(folder);
  return folder;
});
ipcMain.handle('eos:hub-info', () => ({
  running: !!hub,
  pin: hub?.pin ?? null,
  urls: hub?.lanUrls() ?? [],
  endpoints: hub?.endpoints() ?? [],
  dbFile: hub?.db.file ?? null,
  backupDir: hub?.db.backupDir ?? null,
  backups: hub?.db.backups().slice(0, 5) ?? [],
  stats: hub?.db.stats() ?? null,
  watcher: !!watcher,
}));
ipcMain.handle('eos:open-data-folder', () => {
  if (hub) void shell.openPath(dirname(hub.db.file));
});

app.on('before-quit', () => {
  quitting = true;
  stopWatcher();
});
app.on('window-all-closed', () => {
  // stay alive in the tray
});
