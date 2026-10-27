import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs submitted Python against hidden tests, on this PC, in a temporary folder:
//   solution.py   — the submitted code (imported as module "solution")
//   harness.py    — loads it, exposes `entry` (the function under test) and `solution` to the hidden
//                   test file, runs every test_* function and prints one JSON line
// Python runs isolated (-I: no user site-packages, no current-folder imports) with a hard timeout.
// Hidden tests never leave the hub; only names, pass/fail and the first error line come back.

export interface TestOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface RunResult {
  ok: boolean; // every test passed
  passed: number;
  total: number;
  tests: TestOutcome[];
  error?: string; // the code did not load / timed out / Python missing
  ms: number;
}

const HARNESS = String.raw`
import importlib.util, json, sys, traceback, types
out = {"tests": [], "error": None}
def short(e):
    tb = traceback.extract_tb(e.__traceback__)
    where = (" (line %d)" % tb[-1].lineno) if tb else ""
    return (type(e).__name__ + ": " + str(e))[:300] + where
try:
    spec = importlib.util.spec_from_file_location("solution", sys.argv[1])
    solution = importlib.util.module_from_spec(spec)
    sys.modules["solution"] = solution
    spec.loader.exec_module(solution)
    entry = getattr(solution, sys.argv[3], None)
    if entry is None:
        raise NameError("function %s is not defined" % sys.argv[3])
    ns = {"__name__": "hidden_tests", "solution": solution, "entry": entry}
    exec(compile(open(sys.argv[2], encoding="utf-8").read(), "hidden_tests", "exec"), ns)
    for name, fn in sorted(ns.items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                out["tests"].append({"name": name, "ok": True})
            except AssertionError as e:
                out["tests"].append({"name": name, "ok": False, "error": ("AssertionError: " + str(e))[:300] if str(e) else "AssertionError"})
            except Exception as e:
                out["tests"].append({"name": name, "ok": False, "error": short(e)})
except Exception as e:
    out["error"] = short(e)
sys.stdout.write("\n__STUDY_RESULT__" + json.dumps(out) + "\n")
`;

let cached: string[] | null | undefined;

const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));

/** The Python to use: STUDY_PYTHON, then python3, python, py -3. Null when none works. */
export function findPython(): string[] | null {
  if (cached !== undefined) return cached;
  const candidates: string[][] = [...(process.env.STUDY_PYTHON ? [process.env.STUDY_PYTHON.split(' ')] : []), ['python3'], ['python'], ['py', '-3']];
  for (const c of candidates) {
    const r = spawnSync(c[0], [...c.slice(1), '-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (r.status === 0 && r.stdout.trim() === '3') return (cached = c);
  }
  return (cached = null);
}

export function runHidden(code: string, hiddenTestsFile: string, entry: string, timeoutSec = 20): Promise<RunResult> {
  const t0 = Date.now();
  const py = findPython();
  if (!py) return Promise.resolve({ ok: false, passed: 0, total: 0, tests: [], error: 'Python 3 was not found on this PC. Install it (python.org) or set STUDY_PYTHON.', ms: 0 });
  if (!existsSync(hiddenTestsFile)) return Promise.resolve({ ok: false, passed: 0, total: 0, tests: [], error: 'The hidden tests for this task are missing (the job that writes them has not run yet).', ms: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'study-lab-'));
  writeFileSync(join(dir, 'solution.py'), code);
  writeFileSync(join(dir, 'harness.py'), HARNESS);
  writeFileSync(join(dir, 'hidden_tests.py'), readFileSync(hiddenTestsFile, 'utf8'));
  return new Promise((resolve) => {
    const child = spawn(py[0], [...py.slice(1), '-I', join(dir, 'harness.py'), join(dir, 'solution.py'), join(dir, 'hidden_tests.py'), entry], { cwd: dir, windowsHide: true, env: { ...pick(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'USERPROFILE']), PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' } });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutSec * 1000);
    child.stdout.on('data', (b: Buffer) => {
      if (stdout.length < 2_000_000) stdout += b.toString('utf8');
    });
    child.stderr.on('data', (b: Buffer) => {
      if (stderr.length < 20_000) stderr += b.toString('utf8');
    });
    const done = (r: Omit<RunResult, 'ms'>) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ ...r, ms: Date.now() - t0 });
    };
    child.on('error', (e) => done({ ok: false, passed: 0, total: 0, tests: [], error: `Could not start Python: ${e.message}` }));
    child.on('close', () => {
      if (killed) return done({ ok: false, passed: 0, total: 0, tests: [], error: `Stopped after ${timeoutSec} s (an endless loop?).` });
      const i = stdout.lastIndexOf('__STUDY_RESULT__');
      if (i < 0) return done({ ok: false, passed: 0, total: 0, tests: [], error: (stderr.trim().split('\n').pop() ?? 'The code crashed Python.').slice(0, 300) });
      const r = JSON.parse(stdout.slice(i + '__STUDY_RESULT__'.length).split('\n')[0]) as { tests: TestOutcome[]; error: string | null };
      const passed = r.tests.filter((t) => t.ok).length;
      done({ ok: !r.error && r.tests.length > 0 && passed === r.tests.length, passed, total: r.tests.length, tests: r.tests, ...(r.error ? { error: r.error } : r.tests.length ? {} : { error: 'The hidden test file has no test_ functions.' }) });
    });
  });
}
