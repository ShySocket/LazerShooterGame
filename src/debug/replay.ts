import { VisionPipeline, type LockState } from '../vision/pipeline';
import { CALIBRATION_VERSION } from '../vision/calibration';
import { assertRecording, restoreDetection, type Recording } from './recorder';

export interface ReplayResult {
  frames: number;
  periodMs: number;
  /** Shots by verdict: who was hit, or why nothing registered; `verdict` judges a hit against the tap's expected target when it was labelled. */
  shots: { t: number; outcome: 'hit' | 'unclear' | 'miss' | 'stale' | 'busy'; id?: string; elapsedMs: number; expectedId?: string | null; verdict?: 'correct' | 'wrong' | 'unlabelled' }[];
  hitsBy: Record<string, number>;
  unclear: number;
  miss: number;
  stale: number;
  /** Labelled taps (the shooter said who they aimed at), and how the hits among them were judged. */
  labelled: number;
  correct: number;
  wrong: number;
  /** Green-lock frames per player. */
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
  assertRecording(rec);
  let now = 0;
  const everyone = new Set(rec.candidates.map((c) => c.id).filter((id) => id !== rec.selfId));
  const config = {
    candidates: rec.candidates,
    exclusiveIds: new Set(rec.candidates.map((c) => c.id)),
    eligible: everyone,
    hitThreshold: overrides.hitThreshold ?? rec.hitThreshold,
    hitMargin: overrides.hitMargin ?? rec.hitMargin,
  };
  const pipeline = new VisionPipeline<{ t: number; expectedId?: string | null }>(config, () => now);
  const result: ReplayResult = { frames: 0, periodMs: NaN, shots: [], hitsBy: {}, unclear: 0, miss: 0, stale: 0, labelled: 0, correct: 0, wrong: 0, locksBy: {}, calibration: CALIBRATION_VERSION, recordedWith: rec.calibration };
  const settle = (t: number, s: { resolution: { id: string } | null; track: unknown; elapsedMs: number; context: { expectedId?: string | null } }) => {
    const expectedId = s.context.expectedId;
    const labelled = expectedId !== undefined;
    if (s.resolution) {
      const verdict = !labelled ? 'unlabelled' : s.resolution.id === expectedId ? 'correct' : 'wrong';
      result.shots.push({ t, outcome: 'hit', id: s.resolution.id, elapsedMs: s.elapsedMs, expectedId, verdict });
      result.hitsBy[s.resolution.id] = (result.hitsBy[s.resolution.id] ?? 0) + 1;
      if (verdict === 'correct') result.correct++;
      if (verdict === 'wrong') result.wrong++;
    } else if (s.track) {
      result.shots.push({ t, outcome: 'unclear', elapsedMs: s.elapsedMs, expectedId });
      result.unclear++;
    } else {
      result.shots.push({ t, outcome: 'miss', elapsedMs: s.elapsedMs, expectedId });
      result.miss++;
    }
    if (labelled) result.labelled++;
  };
  let pending = null as { token: object; deadline: number } | null;
  const fires = [...rec.fires].sort((a, b) => a.t - b.t);
  let fi = 0;
  // Frames in capture order; two frames stamped the same instant would reset the tracker, so the
  // second is nudged by a tenth of a millisecond.
  const frames = [...rec.frames].sort((a, b) => a.t - b.t).map((f, i, all) => (i > 0 && f.t <= all[i - 1].t ? { ...f, t: all[i - 1].t + 0.1 } : f));
  const tap = (fire: (typeof fires)[number]) => {
    if (pending && pending.deadline <= fire.t) {
      now = pending.deadline;
      const s = pipeline.expirePending(pending.token);
      pending = null;
      if (s) settle(now, s);
    }
    now = fire.t;
    const labelled = fire.expectedId !== undefined;
    // The game only lets a hit resolve to a live opponent; replay honours what was eligible at the tap.
    pipeline.configure({ ...config, eligible: fire.eligible ? new Set(fire.eligible) : everyone });
    const r = pipeline.fire({ t: now, expectedId: fire.expectedId }, fire.crosshair);
    if (r.kind === 'pending') pending = { token: r.token, deadline: r.deadline };
    else if (r.kind === 'instant') settle(now, r.settlement);
    else {
      if (r.kind === 'stale' || r.kind === 'no-camera') {
        result.shots.push({ t: now, outcome: 'stale', elapsedMs: 0, expectedId: fire.expectedId });
        result.stale++;
        if (labelled) result.labelled++;
      } else if (r.kind === 'miss') {
        result.shots.push({ t: now, outcome: 'miss', elapsedMs: 0, expectedId: fire.expectedId });
        result.miss++;
        if (labelled) result.labelled++;
      } else {
        // 'busy' is an artefact of replay's period estimate (the game never records a tap it refused as busy): not a labelled shot.
        result.shots.push({ t: now, outcome: 'busy', elapsedMs: 0, expectedId: fire.expectedId });
      }
    }
  };
  // A frame completes one period after capture; the recording does not carry completion times, so
  // the median spacing between captures stands in for the phone's inference time.
  const gaps = frames.slice(1).map((f, i) => f.t - frames[i].t).sort((a, b) => a - b);
  const period = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 200;
  for (const f of frames) {
    const completeAt = f.t + period;
    // Taps that happened while this frame was being processed.
    while (fi < fires.length && fires[fi].t < completeAt) tap(fires[fi++]);
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
    if (lock?.kind === 'lock') result.locksBy[lock.id] = (result.locksBy[lock.id] ?? 0) + 1;
  }
  // Taps after the last frame completed still get their verdict from that frame.
  while (fi < fires.length) tap(fires[fi++]);
  if (pending) {
    now = pending.deadline;
    const s = pipeline.expirePending(pending.token);
    if (s) settle(now, s);
  }
  if (result.shots.length !== rec.fires.length) throw new Error(`replay produced ${result.shots.length} verdicts for ${rec.fires.length} taps`);
  return result;
}
