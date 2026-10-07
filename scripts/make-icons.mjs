// Renders the Execution OS icon (a 24h dial with the vermilion "now" hand) to every PNG size
// needed by the web app, Windows EXE, Android APK and the browser extension.
// Also synthesises the temple-bell alarm WAV used by the Android alarm channel.
import { Resvg } from '@resvg/resvg-js';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PAPER = '#F6F4EF';
const INK = '#1C1B19';
const ACCENT = '#D9480F';

function iconSvg({ bg = true, scale = 1 } = {}) {
  const s = 512;
  const c = s / 2;
  const r = 150 * scale;
  const w = 34 * scale;
  const arc = (a0, a1, rad) => {
    const p = (a) => [c + rad * Math.cos(((a - 90) * Math.PI) / 180), c + rad * Math.sin(((a - 90) * Math.PI) / 180)];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M ${x0} ${y0} A ${rad} ${rad} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const segs = [
    [0, 60, '#4C5A86'],
    [62, 118, '#C98A0B'],
    [120, 148, '#B4563A'],
    [150, 178, '#1F6FB2'],
    [180, 252, '#2E7D4F'],
    [254, 268, '#B4563A'],
    [270, 284, '#2E7D4F'],
    [286, 300, '#C98A0B'],
    [302, 314, '#2C8C88'],
    [316, 358, '#4C5A86'],
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  ${bg ? `<rect width="${s}" height="${s}" rx="112" fill="${PAPER}"/>` : ''}
  ${segs.map(([a, b, col]) => `<path d="${arc(a, b, r)}" fill="none" stroke="${col}" stroke-width="${w}"/>`).join('\n  ')}
  <line x1="${c}" y1="${c}" x2="${c + (r + 26 * scale) * Math.cos((-90 + 165) * Math.PI / 180)}" y2="${c + (r + 26 * scale) * Math.sin((-90 + 165) * Math.PI / 180)}" stroke="${ACCENT}" stroke-width="${16 * scale}" stroke-linecap="round"/>
  <circle cx="${c}" cy="${c}" r="${22 * scale}" fill="${INK}"/>
</svg>`;
}

function render(svg, size, out) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
}

const full = iconSvg();
render(full, 192, 'public/icon-192.png');
render(full, 512, 'public/icon-512.png');
render(full, 512, 'build-res/icon.png');
writeFileSync('build-res/icon.ico', makeIco(full, [16, 24, 32, 48, 64, 128, 256]));
render(full, 16, 'extension/icon-16.png');
render(full, 48, 'extension/icon-48.png');
render(full, 128, 'extension/icon-128.png');

// Android launcher icons (only when the android project exists)
const res = 'android/app/src/main/res';
if (existsSync(res)) {
  const legacy = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const fg = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  const foreground = iconSvg({ bg: false, scale: 0.72 });
  for (const [d, px] of Object.entries(legacy)) {
    render(full, px, join(res, `mipmap-${d}`, 'ic_launcher.png'));
    render(full, px, join(res, `mipmap-${d}`, 'ic_launcher_round.png'));
  }
  for (const [d, px] of Object.entries(fg)) render(foreground, px, join(res, `mipmap-${d}`, 'ic_launcher_foreground.png'));
  // adaptive icon background colour
  const bgXml = join(res, 'values', 'ic_launcher_background.xml');
  writeFileSync(bgXml, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${PAPER}</color>\n</resources>\n`);
  // monochrome status-bar icon for notifications
  const stat = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><circle cx="48" cy="48" r="34" fill="none" stroke="#fff" stroke-width="9"/><line x1="48" y1="48" x2="48" y2="22" stroke="#fff" stroke-width="9" stroke-linecap="round"/><circle cx="48" cy="48" r="7" fill="#fff"/></svg>`;
  const statSizes = { mdpi: 24, hdpi: 36, xhdpi: 48, xxhdpi: 72, xxxhdpi: 96 };
  for (const [d, px] of Object.entries(statSizes)) render(stat, px, join(res, `drawable-${d}`, 'ic_stat_eos.png'));
  // alarm sound
  mkdirSync(join(res, 'raw'), { recursive: true });
  writeFileSync(join(res, 'raw', 'eos_bell.wav'), bellWav());
  // splash screens: keep each existing size, paper background with the dial in the middle
  for (const dir of readdirSync(res)) {
    const f = join(res, dir, 'splash.png');
    if (!existsSync(f)) continue;
    const buf = readFileSync(f);
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    const size = Math.round(Math.min(w, h) * 0.28);
    const inner = iconSvg({ bg: false }).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const splash = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${PAPER}"/><g transform="translate(${(w - size) / 2} ${(h - size) / 2}) scale(${size / 512})">${inner}</g></svg>`;
    writeFileSync(f, new Resvg(splash, { fitTo: { mode: 'original' } }).render().asPng());
  }
  console.log('Android icons, splash screens + alarm sound written');
}
console.log('Icons written');

// ---- Windows .ico (PNG-compressed entries, supported since Windows Vista) ----
function makeIco(svg, sizes) {
  const pngs = sizes.map((px) => new Resvg(svg, { fitTo: { mode: 'width', value: px } }).render().asPng());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((px, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(px >= 256 ? 0 : px, e);
    header.writeUInt8(px >= 256 ? 0 : px, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

// ---- temple bell WAV (mono 16-bit 22.05 kHz, ~7 s, three strikes) ----
function bellWav() {
  const rate = 22050;
  const seconds = 7.5;
  const n = Math.floor(rate * seconds);
  const data = new Float32Array(n);
  const partials = [
    [1, 1],
    [2.0, 0.5],
    [2.76, 0.35],
    [5.4, 0.18],
    [8.93, 0.08],
  ];
  const strike = (t0, base, vol) => {
    for (let i = Math.floor(t0 * rate); i < n; i++) {
      const t = i / rate - t0;
      let v = 0;
      for (const [ratio, amp] of partials) v += amp * Math.sin(2 * Math.PI * base * ratio * t) * Math.exp((-t * 1.3 * ratio ** 0.4) / 1);
      data[i] += v * vol * Math.min(1, t * 200);
    }
  };
  strike(0, 247, 0.35);
  strike(2.4, 247, 0.45);
  strike(4.8, 247, 0.55);
  let peak = 0;
  for (const v of data) peak = Math.max(peak, Math.abs(v));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((data[i] / peak) * 0.9 * 32767), 44 + i * 2);
  return buf;
}
