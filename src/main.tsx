import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-sans-devanagari/400.css';
import '@fontsource/ibm-plex-sans-devanagari/500.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startSync } from './state/sync';
import { isCapacitor, isElectron } from './lib/platform';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void startSync();

// Offline support for the browser / iPhone home-screen version (needs a secure context).
if ('serviceWorker' in navigator && window.isSecureContext && !isCapacitor && !isElectron && !import.meta.env.DEV) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
