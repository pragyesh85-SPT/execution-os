// Bump the app version everywhere it lives: package.json (source of truth),
// android/app/build.gradle (versionName + versionCode = major*10000 + minor*100 + patch)
// and a dated heading in CHANGELOG.md.
//   node scripts/bump-version.mjs <major|minor|patch|X.Y.Z>
import { readFileSync, writeFileSync } from 'node:fs';

const kind = process.argv[2];
if (!kind) {
  console.error('Usage: npm run version:bump -- <major|minor|patch|X.Y.Z>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
let next;
if (kind === 'major') next = [maj + 1, 0, 0];
else if (kind === 'minor') next = [maj, min + 1, 0];
else if (kind === 'patch') next = [maj, min, pat + 1];
else if (/^\d+\.\d+\.\d+$/.test(kind)) next = kind.split('.').map(Number);
else {
  console.error(`Unknown bump "${kind}"`);
  process.exit(1);
}
const version = next.join('.');
const code = next[0] * 10000 + next[1] * 100 + next[2];

pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

const lockFile = 'package-lock.json';
try {
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
} catch {
  /* no lock file */
}

const gradleFile = 'android/app/build.gradle';
let gradle = readFileSync(gradleFile, 'utf8');
gradle = gradle.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "${version}"`);
writeFileSync(gradleFile, gradle);

const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
let log = readFileSync('CHANGELOG.md', 'utf8');
if (!log.includes(`## [${version}]`)) {
  log = log.includes('## [Unreleased]')
    ? log.replace('## [Unreleased]', `## [Unreleased]\n\n## [${version}] - ${date}`)
    : log.replace(/\n## /, `\n## [${version}] - ${date}\n\n## `);
  writeFileSync('CHANGELOG.md', log);
}

console.log(`Version ${version} (Android versionCode ${code})`);
