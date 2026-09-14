import type { BodyResult, FaceResult } from '@vladmandic/human';
import type { NBox } from '../vision/geometry';
import type { Detection } from '../vision/tracker';
import type { FaceObservation, FrameOps, OutfitObservation } from '../vision/pipeline';
import type { Candidate } from '../vision/scoring';
import { CALIBRATION_VERSION } from '../vision/calibration';

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

const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;
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

  fire(t: number, crosshair: NBox, expectedId?: string | null): void {
    const f: RecordedFire = { t: round(t, 1), crosshair: roundBox(crosshair) };
    if (expectedId !== undefined) f.expectedId = expectedId;
    this.fires.push(f);
  }

  get frameCount(): number {
    return this.frames.length;
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

  reset(): void {
    this.frames = [];
    this.fires = [];
  }
}
