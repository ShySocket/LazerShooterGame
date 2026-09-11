import type { BodyResult, FaceResult } from '@vladmandic/human';
import type { BodyProps, OutfitSig, Profile } from '../../src/types';
import { BODY_MODEL } from '../../src/types';
import { FACE_MODEL } from '../../src/vision/embedding';
import type { NBox } from '../../src/vision/geometry';
import type { Detection } from '../../src/vision/tracker';
import type { FaceObservation, OutfitObservation } from '../../src/vision/pipeline';
import { Rng } from './rng';

/**
 * A synthetic laser-tag scene. People have a true appearance (face vector, outfit histogram, body
 * ratios); the "detector" reports them with distance-dependent dropouts, jitter, and similarity
 * levels chosen to match what the real models produce on a phone. Frame coordinates are normalised
 * 0..1 of a portrait 720x1280 frame.
 */

export const FRAME_W = 720;
export const FRAME_H = 1280;
const DIM = 64;
/** Vertical field of view of a phone rear camera in portrait, in metres of scene per metre of distance. */
const FOV_M_PER_M = 1.15;
const PERSON_H = 1.7;
const FACE_H = 0.22;

export type Facing = 'front' | 'back' | 'side';

export interface PersonSpec {
  id: string;
  /** Enrolled in the room; strangers are not. */
  player: boolean;
  x: number;
  distance: number;
  facing: Facing;
  /** Horizontal speed in frame widths per second. */
  vx?: number;
  /** Speed towards (negative) or away from the camera in m/s. */
  vd?: number;
  /** Main hue bin 0..11 of the top; a look-alike top shares the hue. */
  topHue: number;
  /** Saturation/value bin 0..3 of the top; set it to make two tops identical, otherwise random. */
  topShade?: number;
  /** Optional: this person's face and outfit are copies of another id (a mirror, a twin). */
  copyOf?: string;
}

export interface Person extends PersonSpec {
  face: number[];
  top: number[];
  props: BodyProps;
  faceSamples: number[][];
  outfitFront: OutfitSig;
  outfitBack: OutfitSig;
}

/** Detector behaviour by distance. Guesses anchored on 720p MoveNet MultiPose and BlazeFace on a phone. */
export interface DetectorModel {
  /** Extra body dropout, e.g. 0.2 for a flaky pose model. */
  bodyDropout: number;
  /** Multiplier on face crop availability. */
  faceAvailability: number;
  /** Shift of same-person face similarity, e.g. -0.05 for poor light. */
  faceSimShift: number;
  /** Probability of a spurious body somewhere in the frame. */
  ghostRate: number;
}

export const DEFAULT_DETECTOR: DetectorModel = { bodyDropout: 0, faceAvailability: 1, faceSimShift: 0, ghostRate: 0.01 };

const lerp = (d: number, pts: [number, number][]): number => {
  if (d <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (d <= pts[i][0]) return pts[i - 1][1] + ((d - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0])) * (pts[i][1] - pts[i - 1][1]);
  return pts[pts.length - 1][1];
};
const pBody = (d: number) => lerp(d, [[2, 0.97], [4, 0.93], [6, 0.86], [8, 0.72], [10, 0.5]]);
const pFaceBox = (d: number) => lerp(d, [[2, 0.95], [4, 0.8], [6, 0.4], [8, 0.1]]);
const pCrop = (d: number) => lerp(d, [[2, 0.95], [4, 0.9], [6, 0.7], [8, 0.35], [10, 0.1]]);
const simOwn = (d: number) => lerp(d, [[2, 0.62], [4, 0.58], [6, 0.5], [8, 0.42]]);

function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
function randomUnit(rng: Rng): number[] {
  return unit(Array.from({ length: DIM }, () => rng.gauss()));
}
/** A unit vector with cosine exactly `cos` to `u`. */
function withCosine(rng: Rng, u: number[], cos: number): number[] {
  const n = randomUnit(rng);
  const dot = n.reduce((s, x, i) => s + x * u[i], 0);
  const perp = unit(n.map((x, i) => x - dot * u[i]));
  const c = Math.max(-1, Math.min(1, cos));
  const s = Math.sqrt(1 - c * c);
  return u.map((x, i) => c * x + s * perp[i]);
}

const SIG_LEN = 51;
function topHistogram(hue: number, shade: number): number[] {
  const h = new Array(SIG_LEN).fill(0);
  h[hue * 4 + shade] += 0.62;
  h[hue * 4 + (shade ^ 1)] += 0.13;
  h[((hue + 1) % 12) * 4 + shade] += 0.06;
  h[((hue + 11) % 12) * 4 + shade] += 0.06;
  h[48 + (shade & 1 ? 2 : 1)] += 0.13;
  return h;
}
function perturb(rng: Rng, h: number[], amount: number): number[] {
  const out = h.map((v) => Math.max(0, v * (1 + rng.gauss(0, amount))));
  for (let k = 0; k < 3; k++) out[Math.floor(rng.next() * SIG_LEN)] += amount * 0.15;
  const n = out.reduce((a, b) => a + b, 0);
  return out.map((v) => v / n);
}

export interface Scene {
  people: Person[];
  profiles: Record<string, Profile>;
  /** The shooter's own profile; it is a candidate decoy like everyone else's. */
  selfId: string;
}

/** Shared component so unrelated faces sit at about 0.2 cosine, like real ArcFace embeddings. */
export function buildScene(rng: Rng, specs: PersonSpec[], selfId = 'me'): Scene {
  const common = randomUnit(rng);
  const people: Person[] = [];
  const byId = new Map<string, Person>();
  const make = (spec: PersonSpec): Person => {
    const src = spec.copyOf ? byId.get(spec.copyOf) : undefined;
    const face = src ? src.face : unit(randomUnit(rng).map((x, i) => x + 0.5 * common[i]));
    const shade = src ? 0 : spec.topShade ?? Math.floor(rng.next() * 4);
    const top = src ? src.top : topHistogram(spec.topHue, shade);
    const props: BodyProps = src
      ? src.props
      : { shoulderTorso: 0.75 + rng.gauss(0, 0.12), hipShoulder: 0.85 + rng.gauss(0, 0.1), legTorso: 1.8 + rng.gauss(0, 0.25), headShoulder: 0.42 + rng.gauss(0, 0.06) };
    const faceSamples = src ? src.faceSamples : Array.from({ length: 8 }, () => withCosine(rng, face, 0.78 + rng.gauss(0, 0.04)));
    const sides = () => ({ top: perturb(rng, top, 0.12) });
    const person: Person = { ...spec, face, top, props, faceSamples, outfitFront: src ? src.outfitFront : sides(), outfitBack: src ? src.outfitBack : sides() };
    byId.set(spec.id, person);
    return person;
  };
  for (const spec of specs) people.push(make(spec));
  const profiles: Record<string, Profile> = {};
  for (const p of people) {
    if (!p.player) continue;
    profiles[p.id] = { faceModel: FACE_MODEL, face: p.faceSamples, outfit: { front: p.outfitFront, back: p.outfitBack }, body: p.props, bodyModel: BODY_MODEL };
  }
  return { people, profiles, selfId };
}

/** Where a person appears in the frame right now. */
export function personBox(p: Person): NBox {
  const h = PERSON_H / (FOV_M_PER_M * p.distance);
  const w = (h * 0.38 * FRAME_H) / FRAME_W;
  const y = 0.5 - h * 0.45;
  return [p.x - w / 2, y, w, h];
}
export function faceBox(p: Person): NBox {
  const [x, y, w, h] = personBox(p);
  const fh = (FACE_H / PERSON_H) * h;
  const fw = (fh * FRAME_H) / FRAME_W;
  return [x + w / 2 - fw / 2, y + h * 0.02, fw, fh];
}
export function facePx(p: Person): number {
  return faceBox(p)[3] * FRAME_H;
}

export interface DetectedFrame {
  dets: Detection[];
  /** Which person a body/face detection came from, for scoring; ghosts map to null. */
  owner: WeakMap<object, Person | null>;
}

/** Full-frame detector output for this instant: bodies and face boxes, no embeddings. */
export function detect(rng: Rng, scene: Scene, model: DetectorModel): { bodies: BodyResult[]; faces: FaceResult[]; owner: Map<object, Person | null> } {
  const bodies: BodyResult[] = [];
  const faces: FaceResult[] = [];
  const owner = new Map<object, Person | null>();
  for (const p of scene.people) {
    const box = personBox(p);
    if (box[0] + box[2] < 0 || box[0] > 1) continue;
    const jitter = () => rng.gauss(0, 0.015) * box[3];
    if (rng.chance(pBody(p.distance) * (1 - model.bodyDropout))) {
      const raw: NBox = [box[0] + jitter(), box[1] + jitter(), box[2] * (1 + rng.gauss(0, 0.05)), box[3] * (1 + rng.gauss(0, 0.04))];
      const fb = faceBox(p);
      const nose: [number, number] = [fb[0] + fb[2] / 2, fb[1] + fb[3] * 0.6];
      const headVisible = p.facing !== 'back' && rng.chance(0.9);
      const body = {
        boxRaw: raw,
        score: 0.6 + rng.next() * 0.35,
        keypoints: headVisible ? [{ part: 'nose', positionRaw: nose, score: 0.8 }] : [],
      } as unknown as BodyResult;
      bodies.push(body);
      owner.set(body, p);
    }
    const facing = p.facing === 'front' ? 1 : p.facing === 'side' ? 0.5 : 0;
    if (facing > 0 && facePx(p) >= 18 && rng.chance(pFaceBox(p.distance) * facing)) {
      const fb = faceBox(p);
      const face = { boxRaw: [fb[0] + jitter() * 0.3, fb[1] + jitter() * 0.3, fb[2], fb[3]], boxScore: 0.6 + rng.next() * 0.35 } as unknown as FaceResult;
      faces.push(face);
      owner.set(face, p);
    }
  }
  if (rng.chance(model.ghostRate)) {
    const ghost = { boxRaw: [rng.next() * 0.8, rng.next() * 0.5, 0.1 + rng.next() * 0.1, 0.2 + rng.next() * 0.2], score: 0.3 + rng.next() * 0.3, keypoints: [] } as unknown as BodyResult;
    bodies.push(ghost);
    owner.set(ghost, null);
  }
  return { bodies, faces, owner };
}

/** What a magnified face crop of `region` returns: one embedding per frontal face inside it. */
export function cropFaces(rng: Rng, scene: Scene, region: NBox, model: DetectorModel): FaceObservation[] {
  // ZoomPass grows the region by 25% on each side.
  const r: NBox = [region[0] - region[2] * 0.25, region[1] - region[3] * 0.25, region[2] * 1.5, region[3] * 1.5];
  const out: FaceObservation[] = [];
  for (const p of scene.people) {
    if (p.facing === 'back') continue;
    const fb = faceBox(p);
    const cx = fb[0] + fb[2] / 2;
    const cy = fb[1] + fb[3] / 2;
    if (cx < r[0] || cx > r[0] + r[2] || cy < r[1] || cy > r[1] + r[3]) continue;
    // The zoom doubles the effective resolution, and the yaw filter drops most side views.
    if (facePx(p) * 2 < 24) continue;
    const availability = pCrop(p.distance) * (p.facing === 'side' ? 0.35 : 1) * model.faceAvailability;
    if (!rng.chance(availability)) continue;
    // Similarity to the true face, so that similarity to the enrolled samples lands near simOwn.
    const target = (simOwn(p.distance) + model.faceSimShift) / 0.78;
    const cos = Math.max(0.1, Math.min(0.98, target + rng.gauss(0, 0.07)));
    const jitter = () => rng.gauss(0, 0.01) * fb[3];
    out.push({ box: [fb[0] + jitter(), fb[1] + jitter(), fb[2], fb[3]], embedding: withCosine(rng, p.face, cos) });
  }
  return out;
}

/** Clothing and body ratios as the pixel sampler would see them. */
export function sampleOutfit(rng: Rng, p: Person | null): OutfitObservation | null {
  if (!p) return { sig: { top: perturb(rng, topHistogram(Math.floor(rng.next() * 12), 1), 0.3) }, props: null };
  const lighting = 0.12 + Math.min(0.15, p.distance * 0.012);
  const props: BodyProps = {
    shoulderTorso: p.props.shoulderTorso + rng.gauss(0, 0.05),
    hipShoulder: p.props.hipShoulder + rng.gauss(0, 0.05),
    legTorso: p.props.legTorso + rng.gauss(0, 0.12),
    headShoulder: p.props.headShoulder + rng.gauss(0, 0.03),
  };
  return { sig: { top: perturb(rng, p.top, lighting) }, props: p.facing === 'side' ? null : props };
}

/** Advance every person by dt seconds. */
export function step(scene: Scene, dtSec: number): void {
  for (const p of scene.people) {
    if (p.vx) p.x += p.vx * dtSec;
    if (p.vd) p.distance = Math.max(1.2, p.distance + p.vd * dtSec);
  }
}
