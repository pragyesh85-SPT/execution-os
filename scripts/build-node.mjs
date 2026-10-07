// Bundles the hub server and the Electron main/preload into self-contained CommonJS files in build/.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false, logLevel: 'info', external: ['node:sqlite'] };

await build({ ...common, entryPoints: ['server/cli.ts'], outfile: 'build/server.cjs' });
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'build/electron-main.cjs', external: ['electron', 'node:sqlite'] });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'build/electron-preload.cjs', external: ['electron', 'node:sqlite'] });
