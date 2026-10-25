// Bundles the hub server and the Electron main/preload into self-contained CommonJS files in build/.
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
  external: ['node:sqlite'],
  define: { __APP_VERSION__: JSON.stringify(version) },
};

await build({ ...common, entryPoints: ['server/cli.ts'], outfile: 'build/server.cjs' });
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'build/electron-main.cjs', external: ['electron', 'node:sqlite'] });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'build/electron-preload.cjs', external: ['electron', 'node:sqlite'] });
