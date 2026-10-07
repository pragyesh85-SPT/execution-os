import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pragyesh.executionos',
  appName: 'Execution OS',
  webDir: 'dist',
  android: {
    // The hub on the PC is plain http on the LAN, so the WebView must allow it.
    allowMixedContent: true,
  },
  server: {
    cleartext: true,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_eos',
      iconColor: '#D9480F',
    },
  },
};

export default config;
