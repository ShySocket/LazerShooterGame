let ctx: AudioContext | null = null;

/** Must be called from a user gesture on iOS before any sound will play. */
export function unlockAudio(): void {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

function tone(f0: number, f1: number, dur: number, type: OscillatorType, gain = 0.3, when = 0): void {
  if (!ctx) return;
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

export function vibrate(pattern: number | number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* unsupported */
  }
}
