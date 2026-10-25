// Bundles the hub server and the Electron main/preload into self-contained CommonJS files in build/,
// and the MCP Apps proposal card into one HTML file (inlined into the hub; no external requests).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

// ---- proposal card (MCP Apps) ----
const card = await build({ entryPoints: ['src/card/card.ts'], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false, logLevel: 'warning', legalComments: 'none' });
const css = `
:root{--bg:#f6f4ef;--surface:#fff;--ink:#1c1b19;--ink2:#57534b;--line:#e2ded4;--accent:#d9480f;--ok:#2e7d4f;--bad:#c0392b;--warn:#b7791f;--track:#efece5;color-scheme:light}
:root[data-theme=dark]{--bg:#121110;--surface:#1c1b19;--ink:#edeae3;--ink2:#a8a397;--line:#2c2a27;--accent:#f26b3a;--ok:#5fc08a;--bad:#ef7a6c;--warn:#e3a54a;--track:#26241f;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121110;--surface:#1c1b19;--ink:#edeae3;--ink2:#a8a397;--line:#2c2a27;--accent:#f26b3a;--ok:#5fc08a;--bad:#ef7a6c;--warn:#e3a54a;--track:#26241f;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:transparent;color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;margin:0 0 10px}
h2{margin:0 0 4px;font-size:15px}.muted{color:var(--ink2);margin:0 0 8px}.warn{color:var(--warn);font-size:13px;margin:4px 0}
.day{margin:10px 0}.label{font-weight:600;font-size:13px;margin-bottom:4px}.row{display:flex;align-items:center;gap:8px;margin:3px 0}.k{width:38px;font-size:11px;color:var(--ink2)}
.bar{position:relative;flex:1;height:18px;border-radius:5px;background:var(--track);overflow:hidden}.bar i{position:absolute;top:2px;bottom:2px;border-radius:3px;border-left:1px solid var(--surface)}
.bar i.fixed{background:repeating-linear-gradient(-45deg,#9a958a 0 3px,var(--track) 3px 6px)}.bar i.pin{outline:2px solid var(--ink);outline-offset:-2px}
ul{margin:6px 0 0;padding-left:18px;font-size:13px}li{margin:2px 0}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}button{font:inherit;font-size:13px;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.5;cursor:default}
.status{margin:8px 0 0;font-size:13px}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}`;
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Execution OS proposal</title><style>${css}</style></head><body><div id="root"></div><script>${card.outputFiles[0].text}</script></body></html>`;
mkdirSync('build', { recursive: true });
writeFileSync('build/card.html', html);
console.log(`  build/card.html  ${(html.length / 1024).toFixed(1)}kb`);
if (html.length > 150 * 1024) throw new Error('The proposal card must stay under 150 KB');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: false,
  logLevel: 'info',
  external: ['node:sqlite'],
  define: { __APP_VERSION__: JSON.stringify(version), __CARD_HTML__: JSON.stringify(html) },
};

await build({ ...common, entryPoints: ['server/cli.ts'], outfile: 'build/server.cjs' });
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'build/electron-main.cjs', external: ['electron', 'node:sqlite'] });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'build/electron-preload.cjs', external: ['electron', 'node:sqlite'] });
