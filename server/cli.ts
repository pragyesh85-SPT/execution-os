import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { startHub } from './hub';

// Stand-alone hub: `npm run serve` (or start-web.bat).
// Serves the web app + sync API for every device on this Wi-Fi.

const root = resolve(dirname(process.argv[1] ?? '.'), '..');
const port = Number(process.env.EOS_PORT ?? 4747);
// Same database as the Windows app, so there is exactly one source of truth on this PC.
const appData = process.env.APPDATA ?? join(homedir(), '.config');
const dbFile = process.env.EOS_DB ?? join(appData, 'execution-os', 'execution-os.db');

// Import the old v1 JSON store only into the real database — never into a custom/test one.
const legacyJson = process.env.EOS_DB ? undefined : join(appData, 'execution-os', 'execution-os.json');

startHub({ port, dbFile, legacyJson, distDir: join(root, 'dist'), log: (m) => console.log(m) })
  .then((hub) => {
    console.log('');
    console.log('  Execution OS is running');
    console.log(`  This PC:        http://localhost:${port}`);
    for (const e of hub.endpoints()) console.log(`  ${e.kind === 'tailscale' ? 'Phone (anywhere, Tailscale)' : 'Phone (home Wi-Fi)'}: ${e.url}`);
    console.log(`  Pairing PIN:    ${hub.pin}`);
    console.log(`  Database:       ${dbFile}`);
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    const stop = () => hub.close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })
  .catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — Execution OS (or the desktop app) is probably already running.`);
      console.error(`Open http://localhost:${port} in your browser.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
