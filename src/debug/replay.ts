import { VisionPipeline, type LockState } from '../vision/pipeline';
import { CALIBRATION_VERSION } from '../vision/calibration';
import { restoreDetection, type Recording } from './recorder';

export interface ReplayResult {
  frames: number;
  periodMs: number;
  /** Shots by verdict: who was hit, or why nothing registered. */
  shots: { t: number; outcome: 'hit' | 'unclear' | 'miss' | 'stale' | 'busy'; id?: string; elapsedMs: number }[];
  hitsBy: Record<string, number>;
  unclear: number;
  miss: number;
  stale: number;
  /** Frames per lock label kind, and per player for green locks. */
  lockFrames: Record<string, number>;
  locksBy: Record<string, number>;
  /** Which calibration decided this replay, against which the recording was made. */
  calibration: string;
  recordedWith: string;
}

/**
 * Re-run a recording through the real pipeline with the current calibration. There is no ground
 * truth in a recording, so the result says what the game would have decided, not whether it was
 * right; compare two calibrations on the same recording, or read it next to the notes.
 */
export async function replayRecording(rec: Recording, overrides: { hitThreshold?: number; hitMargin?: number } = {}): Promise<ReplayResult> {
  let now = 0;
  const eligible = new Set(rec.candidates.map((c) => c.id).filter((id) => id !== rec.selfId));
  const pipeline = new VisionPipeline<{ t: number }>(
    {
      candidates: rec.candidates,
      exclusiveIds: new Set(rec.candidates.map((c) => c.id)),
      eligible,
      hitThreshold: overrides.hitThreshold ?? rec.hitThreshold,
      hitMargin: overrides.hitMargin ?? rec.hitMargin,
    },
    () => now,
  );
  const result: ReplayResult = { frames: 0, periodMs: NaN, shots: [], hitsBy: {}, unclear: 0, miss: 0, stale: 0, lockFrames: {}, locksBy: {}, calibration: CALIBRATION_VERSION, recordedWith: rec.calibration };
  const settle = (t: number, s: { resolution: { id: string } | null; track: unknown; elapsedMs: number }) => {
    if (s.resolution) {
      result.shots.push({ t, outcome: 'hit', id: s.resolution.id, elapsedMs: s.elapsedMs });
      result.hitsBy[s.resolution.id] = (result.hitsBy[s.resolution.id] ?? 0) + 1;
    } else if (s.track) {
      result.shots.push({ t, outcome: 'unclear', elapsedMs: s.elapsedMs });
      result.unclear++;
    } else {
      result.shots.push({ t, outcome: 'miss', elapsedMs: s.elapsedMs });
      result.miss++;
    }
  };
  let pending: { token: object; deadline: number } | null = null;
  const fires = [...rec.fires].sort((a, b) => a.t - b.t);
  let fi = 0;
  const frames = [...rec.frames].sort((a, b) => a.t - b.t);
  // A frame completes one period after capture; the recording does not carry completion times, so
  // the median spacing between captures stands in for the phone's inference time.
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t).sort((a, b) => a - b);
  const period = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 200;
  for (const f of frames) {
    const completeAt = f.t + period;
    // Taps that happened while this frame was being processed.
    while (fi < fires.length && fires[fi].t < completeAt) {
      const fire = fires[fi++];
      if (pending && pending.deadline <= fire.t) {
        now = pending.deadline;
        const s = pipeline.expirePending(pending.token);
        pending = null;
        if (s) settle(now, s);
      }
      now = fire.t;
      const r = pipeline.fire({ t: now }, fire.crosshair);
      if (r.kind === 'pending') pending = { token: r.token, deadline: r.deadline };
      else if (r.kind === 'instant') settle(now, r.settlement);
      else if (r.kind === 'stale' || r.kind === 'no-camera') {
        result.shots.push({ t: now, outcome: 'stale', elapsedMs: 0 });
        result.stale++;
      } else if (r.kind === 'miss') {
        result.shots.push({ t: now, outcome: 'miss', elapsedMs: 0 });
        result.miss++;
      } else result.shots.push({ t: now, outcome: 'busy', elapsedMs: 0 });
    }
    now = completeAt;
    const dets = f.dets.map(restoreDetection);
    const outcome = await pipeline.processFrame(dets, f.t, rec.width, rec.height, f.crosshair, {
      sampleOutfit: (d) => f.outfits[dets.indexOf(d)] ?? null,
      cropFaces: async (_region, d) => f.crops[dets.indexOf(d)] ?? [],
      isCurrent: () => true,
    });
    if (!outcome) continue;
    result.frames++;
    result.periodMs = outcome.periodMs;
    if (outcome.settled) {
      pending = null;
      settle(f.t, outcome.settled);
    }
    const lock: LockState | null = outcome.lock;
    const kind = lock?.kind ?? 'none';
    result.lockFrames[kind] = (result.lockFrames[kind] ?? 0) + 1;
    if (lock?.kind === 'lock') result.locksBy[lock.id] = (result.locksBy[lock.id] ?? 0) + 1;
  }
  if (pending) {
    now = pending.deadline;
    const s = pipeline.expirePending(pending.token);
    if (s) settle(now, s);
  }
  return result;
}
