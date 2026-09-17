import type { Track } from './tracker';
// The timing tunables are documented and versioned in calibration.ts; re-exported here for their callers.
import { BURST_FRAMES, BURST_MS, GEOMETRY_FRESH_MS, MAX_BURST_MS, MAX_STALE_FRAME_MS, STALE_FRAME_MS } from './calibration';
export { BURST_FRAMES, BURST_MS, GEOMETRY_FRESH_MS, MAX_BURST_MS, MAX_STALE_FRAME_MS, STALE_FRAME_MS };

/** How old a finished frame may be for a device that produces one every `periodMs`. */
export function staleAllowanceMs(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return STALE_FRAME_MS;
  return Math.max(STALE_FRAME_MS, Math.min(MAX_STALE_FRAME_MS, Math.round(periodMs * 2.3 + 60)));
}

export function freshFrame(capturedAt: number, now: number, maxAgeMs = STALE_FRAME_MS): boolean {
  return Number.isFinite(capturedAt) && now >= capturedAt && now - capturedAt <= maxAgeMs;
}

/** Whether a frame's positions are recent enough to decide a shot on their own. */
export function geometryFresh(capturedAt: number, now: number): boolean {
  return freshFrame(capturedAt, now, GEOMETRY_FRESH_MS);
}

/** How long a borderline shot may wait for more frames on a device with this frame period: at least two more frames. */
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
  return { ...t, box: [...t.box], hit: [...t.hit], belief: { ...t.belief }, claimed: t.claimed ? { ...t.claimed } : null, faceMean: t.faceMean?.slice() ?? null };
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
