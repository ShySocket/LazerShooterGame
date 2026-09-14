import type { BodyResult, FaceResult } from '@vladmandic/human';
import type { BodyProps, OutfitSig, Profile } from '../../src/types';
import { BODY_MODEL } from '../../src/types';
import { FACE_MODEL, faceQuality } from '../../src/vision/embedding';
import type { NBox } from '../../src/vision/geometry';
import { hitRegion, type Detection } from '../../src/vision/tracker';
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
/**
 * Face vector length. Close to the real model's 512 so the random-cosine spread between unrelated
 * faces (about 1/sqrt(DIM)) matches reality, but not exactly 512: that length would make the game
 * apply the real model's mean-centring to these synthetic vectors, which is meaningless for them.
 */
const DIM = 511;
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
  /** Hue bin of the trousers; random unless set (set it equal to make two outfits identical). */
  bottomHue?: number;
  /** Hair colour bin 0..2; random unless set. */
  hairBin?: number;
  /** Optional: this person's face and outfit are copies of another id (a mirror, a twin). */
  copyOf?: string;
  /** Optional: this person's face resembles another id's at this cosine (siblings, a look-alike). */
  faceLike?: { id: string; cos: number };
  /** Optional: this person wears exactly the same outfit (top, trousers, hair) as another id. */
  outfitOf?: string;
  /** Changes of behaviour during the round, applied once the scene clock passes `at` seconds. */
  script?: { at: number; facing?: Facing; vx?: number; vd?: number }[];
}

export interface Person extends PersonSpec {
  /** Frame offset from the camera pan, written by step() so personBox() needs no scene. */
  panX?: number;
  face: number[];
  top: number[];
  bottom: number[];
  hair: number[];
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
/** Live-vs-enrolment similarity by distance: clean faces measure ~0.5 median, blur at 30 px keeps ~0.7 of it. */
const simOwn = (d: number) => lerp(d, [[2, 0.55], [4, 0.5], [6, 0.42], [8, 0.36]]);

function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
function randomUnit(rng: Rng): number[] {
  return unit(Array.from({ length: DIM }, () => rng.gauss()));
}
/**
 * Spread of the similarity between two unrelated faces. Measured on the real model after mean
 * centring (README, faceMean.ts): median 0, 90th percentile 0.20, 99th 0.39. A normal with this
 * standard deviation puts the 90th at 0.21 and the 99th at 0.38. The sim's vectors bypass the
 * game's centring (DIM is not 512), so their raw cosine plays the part of the centred similarity.
 */
const STRANGER_SIM_SD = 0.165;

/**
 * A new face whose cosine to each earlier face is an independent draw from the stranger
 * distribution, solved exactly: orthonormalise the references (Gram-Schmidt), back-substitute the
 * coefficients so every requested dot product holds, and fill the rest with a random perpendicular.
 */
function unrelatedFace(rng: Rng, refs: number[][]): number[] {
  if (refs.length === 0) return randomUnit(rng);
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
  const basis: number[][] = [];
  for (const r of refs) {
    let v = r.slice();
    for (const e of basis) {
      const d = dot(v, e);
      v = v.map((x, i) => x - d * e[i]);
    }
    basis.push(unit(v));
  }
  const wanted = refs.map(() => Math.max(-0.6, Math.min(0.6, rng.gauss(0, STRANGER_SIM_SD))));
  // dot(e_i, ref_j) is zero for i > j, so the coefficients follow from the references in order.
  const coef: number[] = [];
  for (let j = 0; j < refs.length; j++) {
    let acc = wanted[j];
    for (let i = 0; i < j; i++) acc -= coef[i] * dot(basis[i], refs[j]);
    coef.push(acc / dot(basis[j], refs[j]));
  }
  const inPlane = coef.reduce((s, c) => s + c * c, 0);
  const rest = Math.sqrt(Math.max(0, 1 - inPlane));
  let perp = randomUnit(rng);
  for (const e of basis) {
    const d = dot(perp, e);
    perp = perp.map((x, i) => x - d * e[i]);
  }
  perp = unit(perp);
  const face = perp.map((x) => x * rest);
  basis.forEach((e, i) => e.forEach((x, k) => { face[k] += coef[i] * x; }));
  return unit(face);
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

/** A slow side-to-side pan of the phone: every person shifts together in the frame while standing still in the world. */
export interface Pan {
  /** Peak horizontal shift, as a fraction of the frame width. */
  amplitude: number;
  periodS: number;
}

export interface Scene {
  people: Person[];
  /** Scene clock in seconds, advanced by step(). */
  time: number;
  /** Camera pan applied to everybody's frame position; undefined for a steady phone. */
  pan?: Pan;
  /** The pan's current x offset, updated by step(). */
  panX: number;
  profiles: Record<string, Profile>;
  /** The shooter's own profile; it is a candidate decoy like everyone else's. */
  selfId: string;
}

/** Unrelated faces get the measured stranger similarity to every face built before them (unrelatedFace). */
export function buildScene(rng: Rng, specs: PersonSpec[], selfId = 'me'): Scene {
  const people: Person[] = [];
  const byId = new Map<string, Person>();
  const make = (spec: PersonSpec): Person => {
    const src = spec.copyOf ? byId.get(spec.copyOf) : undefined;
    const like = spec.faceLike ? byId.get(spec.faceLike.id) : undefined;
    const face = src ? src.face : like ? withCosine(rng, like.face, spec.faceLike!.cos) : unrelatedFace(rng, [...byId.values()].map((q) => q.face));
    const twin = spec.outfitOf ? byId.get(spec.outfitOf) : undefined;
    const shade = src ? 0 : spec.topShade ?? Math.floor(rng.next() * 4);
    const top = src ? src.top : twin ? twin.top : topHistogram(spec.topHue, shade);
    const bottom = src ? src.bottom : twin ? twin.bottom : topHistogram(spec.bottomHue ?? Math.floor(rng.next() * 12), Math.floor(rng.next() * 4));
    const hair = src ? src.hair : twin ? twin.hair : topHistogram(spec.hairBin ?? Math.floor(rng.next() * 3), Math.floor(rng.next() * 2));
    const props: BodyProps = src
      ? src.props
      : { shoulderTorso: 0.75 + rng.gauss(0, 0.12), hipShoulder: 0.85 + rng.gauss(0, 0.1), legTorso: 1.8 + rng.gauss(0, 0.25), headShoulder: 0.42 + rng.gauss(0, 0.06) };
    const faceSamples = src ? src.faceSamples : Array.from({ length: 8 }, () => withCosine(rng, face, 0.78 + rng.gauss(0, 0.04)));
    const sides = (): OutfitSig => ({ top: perturb(rng, top, 0.12), thighs: perturb(rng, bottom, 0.12), shins: perturb(rng, bottom, 0.15), hair: perturb(rng, hair, 0.15) });
    const person: Person = { ...spec, face, top, bottom, hair, props, faceSamples, outfitFront: src ? src.outfitFront : sides(), outfitBack: src ? src.outfitBack : sides() };
    byId.set(spec.id, person);
    return person;
  };
  for (const spec of specs) people.push(make(spec));
  const profiles: Record<string, Profile> = {};
  for (const p of people) {
    if (!p.player) continue;
    profiles[p.id] = { faceModel: FACE_MODEL, face: p.faceSamples, outfit: { front: p.outfitFront, back: p.outfitBack }, body: p.props, bodyModel: BODY_MODEL };
  }
  return { people, profiles, selfId, time: 0, panX: 0 };
}

/** Where a person appears in the frame right now, including the camera pan. */
export function personBox(p: Person): NBox {
  const h = PERSON_H / (FOV_M_PER_M * p.distance);
  const w = (h * 0.38 * FRAME_H) / FRAME_W;
  const y = 0.5 - h * 0.45;
  return [p.x + (p.panX ?? 0) - w / 2, y, w, h];
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

export interface Keypoint {
  part: string;
  positionRaw: [number, number];
  score: number;
}

/**
 * Ideal pose landmarks on the true silhouette: nose on the face, shoulders at 22% of the height
 * spanning 55% of the width, hips at 52% spanning 40%. The detector jitters and drops these; the
 * oracle uses them as they are.
 */
export function trueKeypoints(p: Person): Keypoint[] {
  const [x, y, w, h] = personBox(p);
  const fb = faceBox(p);
  const cx = x + w / 2;
  return [
    { part: 'nose', positionRaw: [fb[0] + fb[2] / 2, fb[1] + fb[3] * 0.6], score: 0.9 },
    { part: 'leftShoulder', positionRaw: [cx - w * 0.275, y + h * 0.22], score: 0.9 },
    { part: 'rightShoulder', positionRaw: [cx + w * 0.275, y + h * 0.22], score: 0.9 },
    { part: 'leftHip', positionRaw: [cx - w * 0.2, y + h * 0.52], score: 0.9 },
    { part: 'rightHip', positionRaw: [cx + w * 0.2, y + h * 0.52], score: 0.9 },
  ];
}

/**
 * Where a shot may really land on this person: head and torso, computed by the same selector the
 * pipeline uses (hitRegion) on the ideal landmarks, so the oracle and the game agree on what a body
 * is. Arms, legs and the empty corners of the outer box are not part of it.
 */
export function hitBox(p: Person): NBox {
  const box = personBox(p);
  const body = { boxRaw: box, score: 1, keypoints: trueKeypoints(p) } as unknown as BodyResult;
  const face = p.facing === 'back' ? undefined : ({ boxRaw: faceBox(p), boxScore: 1 } as unknown as FaceResult);
  return hitRegion(box, body, face);
}

/** Share of frames in which the pose model misses one landmark of a person it found. */
const KEYPOINT_DROPOUT = 0.05;

export interface DetectedFrame {
  dets: Detection[];
  /** Which person a body/face detection came from, for scoring; ghosts map to null. */
  owner: WeakMap<object, Person | null>;
}

/** Fraction of `box` covered by `other`. */
function covered(box: NBox, other: NBox): number {
  const x1 = Math.max(box[0], other[0]);
  const y1 = Math.max(box[1], other[1]);
  const x2 = Math.min(box[0] + box[2], other[0] + other[2]);
  const y2 = Math.min(box[1] + box[3], other[1] + other[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1) / (box[2] * box[3]);
}

/** How much of this person is hidden behind people standing nearer to the camera. */
export function occlusion(scene: Scene, p: Person): number {
  let worst = 0;
  for (const q of scene.people) if (q !== p && q.distance < p.distance) worst = Math.max(worst, covered(personBox(p), personBox(q)));
  return worst;
}

/** Whether a point on this person is hidden by somebody nearer. */
function pointHidden(scene: Scene, p: Person, x: number, y: number): boolean {
  for (const q of scene.people) {
    if (q === p || q.distance >= p.distance) continue;
    const [bx, by, bw, bh] = personBox(q);
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return true;
  }
  return false;
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
    // A person mostly hidden behind somebody nearer is usually not found; half hidden, found less often.
    const hidden = occlusion(scene, p);
    const pVisible = hidden > 0.7 ? 0.1 : hidden > 0.35 ? 1 - hidden : 1;
    if (rng.chance(pBody(p.distance) * (1 - model.bodyDropout) * pVisible)) {
      const raw: NBox = [box[0] + jitter(), box[1] + jitter(), box[2] * (1 + rng.gauss(0, 0.05)), box[3] * (1 + rng.gauss(0, 0.04))];
      const headVisible = p.facing !== 'back' && rng.chance(0.9);
      // Landmarks jitter less than the box and drop out one at a time; a missing shoulder or hip
      // sends the game's hit region to its fallback, as a flaky pose model does on a phone.
      const keypoints: Keypoint[] = trueKeypoints(p)
        .filter((k) => (k.part === 'nose' ? headVisible : !rng.chance(KEYPOINT_DROPOUT)))
        .map((k) => ({ part: k.part, positionRaw: [k.positionRaw[0] + jitter() * 0.5, k.positionRaw[1] + jitter() * 0.5], score: 0.5 + rng.next() * 0.4 }));
      const body = {
        boxRaw: raw,
        score: 0.6 + rng.next() * 0.35,
        keypoints,
      } as unknown as BodyResult;
      bodies.push(body);
      owner.set(body, p);
    }
    const facing = p.facing === 'front' ? 1 : p.facing === 'side' ? 0.5 : 0;
    const fbox = faceBox(p);
    const faceHidden = pointHidden(scene, p, fbox[0] + fbox[2] / 2, fbox[1] + fbox[3] / 2);
    if (facing > 0 && !faceHidden && facePx(p) >= 18 && rng.chance(pFaceBox(p.distance) * facing)) {
      const fb = fbox;
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
    if (pointHidden(scene, p, cx, cy)) continue;
    // The head crop magnifies the face, and the yaw filter drops most side views.
    if (facePx(p) < 34) continue;
    const availability = pCrop(p.distance) * (p.facing === 'side' ? 0.35 : 1) * model.faceAvailability;
    if (!rng.chance(availability)) continue;
    // Similarity to the true face, so that similarity to the enrolled samples lands near simOwn.
    const target = (simOwn(p.distance) + model.faceSimShift) / 0.78;
    const cos = Math.max(0.1, Math.min(0.98, target + rng.gauss(0, 0.07)));
    const jitter = () => rng.gauss(0, 0.01) * fb[3];
    out.push({ box: [fb[0] + jitter(), fb[1] + jitter(), fb[2], fb[3]], embedding: withCosine(rng, p.face, cos), quality: faceQuality(facePx(p)) });
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
  // Legs and hair are seen less reliably than the top: about a third of samples miss them.
  const sig: OutfitSig = { top: perturb(rng, p.top, lighting) };
  if (rng.chance(0.7)) sig.thighs = perturb(rng, p.bottom, lighting);
  if (rng.chance(0.55)) sig.shins = perturb(rng, p.bottom, lighting + 0.05);
  if (rng.chance(0.6)) sig.hair = perturb(rng, p.hair, lighting);
  return { sig, props: p.facing === 'side' ? null : props };
}

/** Advance every person by dt seconds, applying any scripted changes whose time has come. */
export function step(scene: Scene, dtSec: number): void {
  scene.time += dtSec;
  scene.panX = scene.pan ? scene.pan.amplitude * Math.sin((2 * Math.PI * scene.time) / scene.pan.periodS) : 0;
  for (const p of scene.people) {
    p.panX = scene.panX;
    for (const s of p.script ?? []) {
      if (s.at > scene.time || s.at <= scene.time - dtSec) continue;
      if (s.facing) p.facing = s.facing;
      if (s.vx !== undefined) p.vx = s.vx;
      if (s.vd !== undefined) p.vd = s.vd;
    }
    if (p.vx) p.x += p.vx * dtSec;
    if (p.vd) p.distance = Math.max(1.2, p.distance + p.vd * dtSec);
  }
}
