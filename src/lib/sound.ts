// All sounds are synthesised with WebAudio — no audio files to ship or load.
// The alarm is a struck temple-bell (inharmonic partials, long decay) that grows louder.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** True when the browser is holding audio back until the user interacts with the page. */
export function audioSuspended(): boolean {
  return !ctx || ctx.state !== 'running';
}

/** Call from any user gesture so later alarms are allowed to play. */
export function unlockAudio() {
  audio();
}

function bell(ac: AudioContext, at: number, base: number, volume: number, decay = 3.2) {
  const partials = [
    [1, 1],
    [2.0, 0.5],
    [2.76, 0.35],
    [5.4, 0.18],
    [8.93, 0.08],
  ];
  const master = ac.createGain();
  master.gain.setValueAtTime(0.0001, at);
  master.gain.exponentialRampToValueAtTime(volume, at + 0.01);
  master.gain.exponentialRampToValueAtTime(0.0001, at + decay);
  master.connect(ac.destination);
  for (const [ratio, amp] of partials) {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(base * ratio, at);
    g.gain.setValueAtTime(amp, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay / ratio ** 0.4);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + decay + 0.1);
  }
}

/** Soft two-note chime for block transitions. */
export function chime() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  bell(ac, t, 660, 0.12, 1.6);
  bell(ac, t + 0.18, 880, 0.1, 1.8);
}

/** Short confirmation for completing something. */
export function successTone() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.01;
  bell(ac, t, 523, 0.08, 0.9);
  bell(ac, t + 0.09, 784, 0.08, 1.1);
}

/** Escalating wake alarm. Returns a stop function. */
export function startAlarm(): () => void {
  const ac = audio();
  if (!ac) return () => {};
  let stopped = false;
  const started = performance.now();
  const strike = () => {
    if (stopped) return;
    const elapsed = (performance.now() - started) / 1000;
    const vol = Math.min(0.9, 0.12 + elapsed / 90);
    bell(ac, ac.currentTime + 0.02, 247, vol, 3.5);
    bell(ac, ac.currentTime + 0.05, 370, vol * 0.5, 2.5);
  };
  strike();
  const id = window.setInterval(strike, 2400);
  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}
