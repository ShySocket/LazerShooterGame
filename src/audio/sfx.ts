let ctx: AudioContext | null = null;
let silent: HTMLAudioElement | null = null;
let armed = false;
const listeners = new Set<() => void>();

export type AudioState = 'none' | 'blocked' | 'running';

/** What the game can currently do: 'none' before any tap, 'blocked' when iOS has suspended or interrupted us. */
export function audioState(): AudioState {
  if (!ctx) return 'none';
  return ctx.state === 'running' ? 'running' : 'blocked';
}

export function onAudioStateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
const notify = () => listeners.forEach((cb) => cb());

/**
 * Silent looping media element. While it plays, iOS treats the page as media playback, so Web Audio
 * keeps sounding with the ringer switch on silent and survives interruptions better.
 */
function silentTrack(): HTMLAudioElement {
  if (silent) return silent;
  const rate = 8000;
  const samples = rate / 2;
  const buf = new ArrayBuffer(44 + samples);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  dv.setUint32(4, 36 + samples, true);
  str(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate, true);
  dv.setUint16(32, 1, true);
  dv.setUint16(34, 8, true);
  str(36, 'data');
  dv.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) dv.setUint8(44 + i, 128);
  const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  a.loop = true;
  a.setAttribute('playsinline', 'true');
  a.volume = 0.01;
  silent = a;
  return a;
}

/** Resume from any non-running state. iOS reports 'interrupted' after a call, Siri, app switch, or camera start. */
function resume(): void {
  if (!ctx) return;
  if (ctx.state !== 'running') void ctx.resume().then(notify, notify);
  const s = silentTrack();
  if (s.paused) void s.play().catch(() => undefined);
}

/** Re-arm audio on every later tap and whenever the app comes back to the foreground. */
function arm(): void {
  if (armed) return;
  armed = true;
  const bump = () => resume();
  window.addEventListener('touchend', bump, { passive: true });
  window.addEventListener('click', bump);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
  });
  ctx?.addEventListener('statechange', notify);
}

/** Must be called from a user gesture on iOS before any sound will play. Safe to call often. */
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    arm();
  }
  resume();
  notify();
}

function tone(f0: number, f1: number, dur: number, type: OscillatorType, gain = 0.3, when = 0): void {
  if (!ctx) return;
  if (ctx.state !== 'running') resume();
  const t0 = ctx.currentTime + when;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export const sfx = {
  fire: () => tone(1400, 200, 0.18, 'sawtooth', 0.25),
  hit: () => {
    tone(600, 900, 0.08, 'square', 0.2);
    tone(900, 1400, 0.12, 'square', 0.2, 0.08);
  },
  unclear: () => tone(300, 250, 0.15, 'triangle', 0.2),
  gotHit: () => {
    tone(180, 60, 0.4, 'sawtooth', 0.35);
    tone(90, 40, 0.4, 'square', 0.25);
  },
  eliminated: () => {
    tone(500, 500, 0.15, 'square', 0.25, 0);
    tone(400, 400, 0.15, 'square', 0.25, 0.18);
    tone(250, 120, 0.5, 'square', 0.25, 0.36);
  },
  gameOver: () => {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, f, 0.25, 'triangle', 0.25, i * 0.15));
    tone(1047, 1047, 0.6, 'triangle', 0.25, 0.6);
  },
  tick: () => tone(1000, 1000, 0.05, 'sine', 0.15),
  countdown: () => tone(880, 880, 0.12, 'sine', 0.2),
  go: () => tone(1320, 1320, 0.4, 'sine', 0.25),
};

/** Android vibration. iPhone Safari has no vibration API, so this is a no-op there. */
export function vibrate(pattern: number | number[]): boolean {
  try {
    return typeof navigator.vibrate === 'function' && navigator.vibrate(pattern) === true;
  } catch {
    return false;
  }
}

let hapticSwitch: HTMLLabelElement | null = null;

/**
 * Short tap feedback. Uses the vibration API where it exists. On iOS 18+ Safari, toggling a
 * `<input type="checkbox" switch>` inside a user gesture makes the phone tick, which is the only
 * haptic a web page can produce there. Only fires reliably from a tap, so use it for shooting, not for being hit.
 */
export function haptic(): void {
  if (vibrate(35)) return;
  try {
    if (!hapticSwitch) {
      const label = document.createElement('label');
      label.style.cssText = 'position:fixed;left:-100px;top:-100px;width:1px;height:1px;opacity:0;pointer-events:none;';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      label.appendChild(input);
      document.body.appendChild(label);
      hapticSwitch = label;
    }
    hapticSwitch.click();
  } catch {
    /* unsupported */
  }
}
