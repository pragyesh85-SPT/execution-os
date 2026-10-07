import { contextBridge, ipcRenderer } from 'electron';

// The only native surface the web app can see. Everything else stays sandboxed.
contextBridge.exposeInMainWorld('eosNative', {
  platform: 'electron',
  onWake: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('eos:wake', fn);
    return () => ipcRenderer.off('eos:wake', fn);
  },
  onGuard: (cb: (info: { source: string; title: string }) => void) => {
    const fn = (_e: unknown, info: { source: string; title: string }) => cb(info);
    ipcRenderer.on('eos:guard', fn);
    return () => ipcRenderer.off('eos:guard', fn);
  },
  getAutostart: () => ipcRenderer.invoke('eos:get-autostart') as Promise<boolean>,
  setAutostart: (on: boolean) => ipcRenderer.invoke('eos:set-autostart', on) as Promise<boolean>,
  show: () => ipcRenderer.invoke('eos:show'),
  openExternal: (url: string) => ipcRenderer.invoke('eos:open-external', url),
  openExtensionFolder: () => ipcRenderer.invoke('eos:extension-folder') as Promise<string>,
  hubInfo: () => ipcRenderer.invoke('eos:hub-info'),
  openDataFolder: () => ipcRenderer.invoke('eos:open-data-folder'),
});
