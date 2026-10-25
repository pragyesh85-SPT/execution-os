// Headless / developer setup on any OS:   npm run setup [-- --service] [-- --tailscale]
//   1. checks Node >= 22.5
//   2. npm ci, npm run build, npm test
//   3. --service: start the hub at logon (Windows Task Scheduler, Linux systemd user unit, macOS launchd agent)
//   4. --tailscale: turn on Tailscale Serve (private HTTPS for phones) and print the address
//   5. starts the hub in the foreground; it prints the addresses and a pairing QR in the terminal
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const port = Number(process.env.EOS_PORT ?? 4747);
const step = (t) => console.log(`\n==> ${t}`);
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: process.env.ELECTRON_SKIP_BINARY_DOWNLOAD ?? '1' } });

step(`Node.js ${process.versions.node}`);
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 5)) {
  console.error('Execution OS needs Node.js 22.5 or newer (24 LTS recommended): https://nodejs.org');
  process.exit(1);
}

step('Installing dependencies (npm ci)');
run('npm ci');
step('Building (npm run build)');
run('npm run build');
step('Running the tests (npm test)');
run('npm test');

const server = join(root, 'build', 'server.cjs');

if (args.has('--service')) {
  step('Installing a background service that starts the hub at logon');
  if (process.platform === 'win32') {
    const r = spawnSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Execution OS hub', '/TR', `"${process.execPath}" "${server}" serve`], { stdio: 'inherit' });
    if (r.status !== 0) console.error('Could not create the scheduled task. Run this terminal as your normal user (not elevated) and try again.');
  } else if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.pragyesh.executionos.plist');
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pragyesh.executionos</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${server}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
`,
    );
    spawnSync('launchctl', ['load', '-w', plist], { stdio: 'inherit' });
  } else {
    const dir = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'execution-os.service'),
      `[Unit]
Description=Execution OS hub

[Service]
ExecStart=${process.execPath} ${server} serve
Restart=on-failure

[Install]
WantedBy=default.target
`,
    );
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    spawnSync('systemctl', ['--user', 'enable', '--now', 'execution-os.service'], { stdio: 'inherit' });
  }
  console.log('The hub now starts by itself. Check it with: node build/server.cjs doctor');
}

if (args.has('--tailscale')) {
  step('Turning on Tailscale Serve (private HTTPS for your own devices)');
  const exe = process.platform === 'win32' ? 'C:\\Program Files\\Tailscale\\tailscale.exe' : 'tailscale';
  const r = spawnSync(exe, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`], { encoding: 'utf8' });
  console.log((r.stdout ?? '') + (r.stderr ?? '') || (r.error ? `Tailscale not found: ${r.error.message}` : 'done'));
}

if (args.has('--service')) process.exit(0);
step('Starting the hub (Ctrl+C to stop)');
spawn(process.execPath, [server, 'serve'], { cwd: root, stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
