import type { BodyResult, FaceResult } from '@vladmandic/human';
import type { NBox } from '../vision/geometry';
import type { Detection } from '../vision/tracker';
import type { FaceObservation, FrameOps, OutfitObservation } from '../vision/pipeline';
import type { Candidate } from '../vision/scoring';
import { CALIBRATION_VERSION } from '../vision/calibration';
import { roundTo } from '../util/num';

/**
 * A recording of everything the pipeline saw during a round, as numbers: detector boxes and
 * landmarks, the face embeddings and outfit histograms the crops produced, and every FIRE. Never
 * pixels. A recording replays offline through the real VisionPipeline (src/debug/replay.ts), so a
 * round from a phone can be re-run against a new calibration on a laptop.
 *
 *   phone round ──▶ Recorder (wraps FrameOps) ──▶ JSON ──▶ replayRecording() ──▶ same table as the sim
 */
export const RECORDING_VERSION = 1;

export interface RecordedKeypoint {
  part: string;
  x: number;
  y: number;
  score: number;
}

export interface RecordedDetection {
  box: NBox;
  hit?: NBox;
  ambiguous?: boolean;
  body?: { box: NBox; score: number; keypoints: RecordedKeypoint[] };
  face?: { box: NBox; score: number };
}

export interface RecordedFrame {
  /** Capture time in ms of the recording's clock. */
  t: number;
  crosshair: NBox;
  dets: RecordedDetection[];
  /** Face observations the crop pass produced, by detection index. */
  crops: Record<number, FaceObservation[]>;
  /** Outfit observations, by detection index; null means the readback found nothing usable. */
  outfits: Record<number, OutfitObservation | null>;
}

export interface RecordedFire {
  t: number;
  crosshair: NBox;
  /** Who the shooter says they were aiming at (the range test's target), or null for a stranger; absent when unlabelled. */
  expectedId?: string | null;
  /** The players a hit could resolve to at this tap (alive opponents), so a replay refuses what the game refused. */
  eligible?: string[];
}

export interface Recording {
  version: number;
  calibration: string;
  createdAt: string;
  width: number;
  height: number;
  /** The candidates the round was scored against, including the shooter's own decoy. */
  candidates: Candidate[];
  selfId: string;
  hitThreshold: number;
  hitMargin: number;
  frames: RecordedFrame[];
  fires: RecordedFire[];
  /** Free text: phone, distance, light, who is who. */
  notes?: string;
}

const round = (v: number, d = 4): number => roundTo(v, d);
/** A recording keeps this many frames (about 10 minutes at 5 frames per second) and then stops growing. */
export const RECORDING_MAX_FRAMES = 3000;
const roundBox = (b: NBox): NBox => [round(b[0]), round(b[1]), round(b[2]), round(b[3])];

/** Strip a detection down to the numbers the pipeline reads. */
export function recordDetection(d: Detection): RecordedDetection {
  const out: RecordedDetection = { box: roundBox(d.box) };
  if (d.hit) out.hit = roundBox(d.hit);
  if (d.associationAmbiguous) out.ambiguous = true;
  if (d.body) {
    out.body = {
      box: roundBox(d.body.boxRaw as NBox),
      score: round(d.body.score, 3),
      keypoints: (d.body.keypoints ?? []).map((k) => ({ part: k.part, x: round(k.positionRaw[0]), y: round(k.positionRaw[1]), score: round(k.score, 3) })),
    };
  }
  if (d.face) out.face = { box: roundBox(d.face.boxRaw as NBox), score: round(d.face.boxScore ?? 0, 3) };
  return out;
}

const isBox = (b: unknown): b is NBox => Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === 'number' && Number.isFinite(v));

/** Throws with a plain message when a recording is not one this code can replay; a tampered or hand-edited file must not report hits. */
export function assertRecording(rec: unknown): asserts rec is Recording {
  const r = rec as Partial<Recording> | null;
  if (!r || typeof r !== 'object') throw new Error('not a recording object');
  if (r.version !== RECORDING_VERSION) throw new Error(`recording version ${String(r.version)} is not ${RECORDING_VERSION}`);
  for (const k of ['hitThreshold', 'hitMargin'] as const) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) throw new Error(`${k} must be a number in (0, 1]`);
  }
  if (typeof r.width !== 'number' || typeof r.height !== 'number' || !(r.width > 0 && r.height > 0)) throw new Error('width and height must be positive numbers');
  if (!Array.isArray(r.candidates) || !r.candidates.every((c) => c && typeof c.id === 'string' && c.profile && typeof c.profile === 'object')) throw new Error('candidates must list {id, profile}');
  if (typeof r.selfId !== 'string') throw new Error('selfId must be a string');
  if (!Array.isArray(r.frames) || !Array.isArray(r.fires)) throw new Error('frames and fires must be arrays');
  for (const f of r.frames) {
    if (!f || typeof f.t !== 'number' || !isBox(f.crosshair) || !Array.isArray(f.dets)) throw new Error('a frame needs t, crosshair and dets');
    for (const d of f.dets) {
      if (!isBox(d.box) || (d.hit !== undefined && !isBox(d.hit))) throw new Error('a detection needs a box (and a valid hit box when present)');
      if (d.body && (!isBox(d.body.box) || !Array.isArray(d.body.keypoints))) throw new Error('a body needs a box and keypoints');
      if (d.face && !isBox(d.face.box)) throw new Error('a face needs a box');
    }
  }
  for (const f of r.fires) if (!f || typeof f.t !== 'number' || !isBox(f.crosshair)) throw new Error('a fire needs t and crosshair');
}

/** Rebuild a Detection the pipeline accepts from its recorded form. */
export function restoreDetection(r: RecordedDetection): Detection {
  const d: Detection = { box: [...r.box] as NBox };
  if (r.hit) d.hit = [...r.hit] as NBox;
  if (r.ambiguous) d.associationAmbiguous = true;
  if (r.body) {
    d.body = {
      boxRaw: [...r.body.box],
      score: r.body.score,
      keypoints: r.body.keypoints.map((k) => ({ part: k.part, positionRaw: [k.x, k.y], score: k.score })),
    } as unknown as BodyResult;
  }
  if (r.face) d.face = { boxRaw: [...r.face.box], boxScore: r.face.score, score: r.face.score } as unknown as FaceResult;
  return d;
}

/**
 * Captures one round. Wrap the pipeline's FrameOps with `wrap()` for each frame, hand the frame's
 * detections to `frame()`, and `fire()` on every tap; `recording()` returns the JSON-ready object.
 */
export class Recorder {
  private frames: RecordedFrame[] = [];
  private fires: RecordedFire[] = [];

  constructor(private meta: { width: number; height: number; candidates: Candidate[]; selfId: string; hitThreshold: number; hitMargin: number; notes?: string }) {}

  /** Start a frame: the detections as the pipeline will see them. Returns ops that record what the crops and readbacks produce. */
  frame(t: number, crosshair: NBox, dets: Detection[], ops: FrameOps): FrameOps {
    // A full recording keeps the first RECORDING_MAX_FRAMES frames rather than growing without bound
    // on a phone; the pipeline keeps running with the plain ops.
    if (this.frames.length >= RECORDING_MAX_FRAMES) return ops;
    const f: RecordedFrame = { t: round(t, 1), crosshair: roundBox(crosshair), dets: dets.map(recordDetection), crops: {}, outfits: {} };
    this.frames.push(f);
    const index = (d: Detection) => dets.indexOf(d);
    return {
      sampleOutfit: ops.sampleOutfit
        ? (d) => {
            const obs = ops.sampleOutfit!(d);
            const i = index(d);
            if (i >= 0) f.outfits[i] = obs ? { sig: obs.sig, props: obs.props } : null;
            return obs;
          }
        : null,
      cropFaces: async (region, d) => {
        const faces = await ops.cropFaces(region, d);
        const i = index(d);
        if (i >= 0) f.crops[i] = faces.map((zf) => ({ box: roundBox(zf.box), embedding: zf.embedding.map((v) => round(v, 5)), quality: round(zf.quality, 3) }));
        return faces;
      },
      isCurrent: ops.isCurrent,
    };
  }

  fire(t: number, crosshair: NBox, expectedId?: string | null, eligible?: Iterable<string>): void {
    const f: RecordedFire = { t: round(t, 1), crosshair: roundBox(crosshair) };
    if (expectedId !== undefined) f.expectedId = expectedId;
    if (eligible) f.eligible = [...eligible];
    this.fires.push(f);
  }

  /** Forget the frame just started: the live pipeline abandoned it, so a replay must not see it either. */
  discardLast(): void {
    this.frames.pop();
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get full(): boolean {
    return this.frames.length >= RECORDING_MAX_FRAMES;
  }

  recording(): Recording {
    return {
      version: RECORDING_VERSION,
      calibration: CALIBRATION_VERSION,
      createdAt: new Date().toISOString(),
      width: this.meta.width,
      height: this.meta.height,
      candidates: this.meta.candidates,
      selfId: this.meta.selfId,
      hitThreshold: this.meta.hitThreshold,
      hitMargin: this.meta.hitMargin,
      frames: this.frames,
      fires: this.fires,
      notes: this.meta.notes,
    };
  }

}
