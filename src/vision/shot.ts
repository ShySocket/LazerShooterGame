import type { Track } from './tracker';

/**
 * Age is measured from capture, including all inference time. On a phone the newest finished frame
 * is between one and two inference periods old at any tap, so the allowance follows the measured
 * period instead of assuming a fast device; beyond the ceiling the aim itself is stale.
 */
export const STALE_FRAME_MS = 350;
export const MAX_STALE_FRAME_MS = 1100;

/** How old a finished frame may be for a device that produces one every `periodMs`. */
export function staleAllowanceMs(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return STALE_FRAME_MS;
  return Math.max(STALE_FRAME_MS, Math.min(MAX_STALE_FRAME_MS, Math.round(periodMs * 2.3 + 60)));
}

export function freshFrame(capturedAt: number, now: number, maxAgeMs = STALE_FRAME_MS): boolean {
  return Number.isFinite(capturedAt) && now >= capturedAt && now - capturedAt <= maxAgeMs;
}

/** A borderline shot may wait this long for more frames: at least two more frames on a slow phone. */
export const BURST_MS = 300;
export const MAX_BURST_MS = 900;
/** Frame cap on a burst; the deadline is the real bound, this only stops a runaway fast device. */
export const BURST_FRAMES = 12;

export function burstAllowanceMs(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return BURST_MS;
  return Math.max(BURST_MS, Math.min(MAX_BURST_MS, Math.round(periodMs * 2.5)));
}

/** Robust estimate of the time between finished frames, driven by capture timestamps. */
export class FramePeriod {
  private last = NaN;
  private samples: number[] = [];

  push(capturedAt: number): void {
    if (Number.isFinite(this.last) && capturedAt > this.last) {
      this.samples.push(capturedAt - this.last);
      if (this.samples.length > 12) this.samples.shift();
    }
    this.last = capturedAt;
  }

  /** Median period, or NaN before two frames have arrived. */
  ms(): number {
    if (this.samples.length === 0) return NaN;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  reset(): void {
    this.last = NaN;
    this.samples = [];
  }
}

/** Freeze beliefs as well as geometry so an in-flight frame cannot change the published shot target. */
export function snapshotTrack(t: Track): Track {
  return { ...t, box: [...t.box], belief: { ...t.belief }, claimed: t.claimed ? { ...t.claimed } : null, faceMean: t.faceMean?.slice() ?? null };
}

/** A burst may only confirm the same still-visible target in a fresh frame captured after the tap. */
export function canConfirmShot(
  shot: { trackId: number; startedAt: number; deadline: number },
  inSight: Track | null,
  capturedAt: number,
  now: number,
  maxAgeMs = STALE_FRAME_MS,
): boolean {
  return Boolean(inSight && inSight.id === shot.trackId && capturedAt >= shot.startedAt && now <= shot.deadline && freshFrame(capturedAt, now, maxAgeMs));
}
