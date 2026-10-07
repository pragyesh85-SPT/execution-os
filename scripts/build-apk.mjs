// Builds the Android APK (debug-signed, for personal installs) with Gradle.
// Needs JDK 21 and the Android SDK. Uses JAVA_HOME / ANDROID_HOME from the environment,
// or the EOS_* overrides below. Output: <EOS_BUILD_DIR or ./release>/ExecutionOS-<version>.apk
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pick = (...v) => v.find((x) => x && x.trim());
const env = { ...process.env };
const javaHome = pick(process.env.EOS_JAVA_HOME, process.env.JAVA_HOME);
const sdk = pick(process.env.EOS_ANDROID_HOME, process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT);
if (javaHome) env.JAVA_HOME = javaHome;
if (sdk) env.ANDROID_HOME = env.ANDROID_SDK_ROOT = sdk;
if (process.env.EOS_GRADLE_HOME) env.GRADLE_USER_HOME = process.env.EOS_GRADLE_HOME;
if (!sdk && !existsSync(resolve('android', 'local.properties'))) {
  console.error('Android SDK not found. Set ANDROID_HOME (or EOS_ANDROID_HOME), or create android/local.properties with sdk.dir=...');
  process.exit(1);
}

const android = resolve('android');
const gradlew = process.platform === 'win32' ? `"${join(android, 'gradlew.bat')}"` : './gradlew';
execSync(`${gradlew} assembleDebug --no-daemon`, { cwd: android, env, stdio: 'inherit' });

const candidates = [
  process.env.EOS_ANDROID_BUILD_DIR && join(process.env.EOS_ANDROID_BUILD_DIR, 'app', 'outputs', 'apk', 'debug', 'app-debug.apk'),
  join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
].filter(Boolean);
const apk = candidates.find((p) => existsSync(p));
if (!apk) throw new Error('APK not found after build');

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const outDir = process.env.EOS_BUILD_DIR ? join(process.env.EOS_BUILD_DIR, 'release') : resolve('release');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `ExecutionOS-${version}.apk`);
copyFileSync(apk, out);
console.log(`\nAPK ready: ${out}`);
