import type { BodyResult } from '@vladmandic/human';
import { REGION_CONTRADICTION_CAP } from './calibration';
import type { BodyProps, OutfitSides, OutfitSig } from '../types';
import { roundTo } from '../util/num';

/** 12 hues x 2 saturation x 2 value bins, plus 3 grey bins. */
const SIG_LEN = 51;

type Pt = [number, number];
type Quad = [Pt, Pt, Pt, Pt];
type Part = BodyResult['keypoints'][number]['part'];

function keypoints(body: BodyResult, minScore: number, pixels = false): Partial<Record<string, Pt>> {
  const pts: Partial<Record<string, Pt>> = {};
  for (const kp of body.keypoints) {
    // The pose model can extrapolate joints outside the image. Those do not describe visible clothing.
    if (!Number.isFinite(kp.score) || kp.score < minScore || ![kp.positionRaw[0], kp.positionRaw[1]].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) continue;
    const point = pixels ? kp.position : kp.positionRaw;
    if (!point.slice(0, 2).every(Number.isFinite)) continue;
    pts[kp.part] = [point[0], point[1]];
  }
  return pts;
}

function quadOf(pts: Partial<Record<string, Pt>>, a: Part, b: Part, c: Part, d: Part): Quad | null {
  const q = [pts[a], pts[b], pts[c], pts[d]];
  return q.every(Boolean) ? (q as Quad) : null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Crossing or collapsed joints cannot define a reliable clothing patch. */
function convexQuad(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (!Number.isFinite(cross) || Math.abs(cross) < 1e-8) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

/** A quad around a limb segment, widened to roughly the limb's thickness. */
function limbQuad(top: Pt, bottom: Pt, halfWidth: number): Quad {
  const dx = bottom[0] - top[0];
  const dy = bottom[1] - top[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * halfWidth;
  const ny = (dx / len) * halfWidth;
  return [
    [top[0] + nx, top[1] + ny],
    [top[0] - nx, top[1] - ny],
    [bottom[0] - nx, bottom[1] - ny],
    [bottom[0] + nx, bottom[1] + ny],
  ];
}

/**
 * Sampling regions for every clothing area the pose makes visible. Legs are sampled from both
 * sides when available; hair is the band above the eyes and ears.
 */
export function outfitRegions(body: BodyResult, minScore = 0.4, aspect = 1): Partial<Record<keyof OutfitSig, Quad[]>> {
  const p = keypoints(body, minScore);
  const out: Partial<Record<keyof OutfitSig, Quad[]>> = {};
  if (!Number.isFinite(aspect) || aspect <= 0) return out;
  // Work in units of frame height: x/y must have the same scale for limb normals and hair height.
  for (const point of Object.values(p)) if (point) point[0] *= aspect;
  const torso = quadOf(p, 'leftShoulder', 'rightShoulder', 'rightHip', 'leftHip');
  if (!torso || !convexQuad(torso)) return out;
  out.top = [torso];
  const shoulderW = dist(p.leftShoulder!, p.rightShoulder!);
  const legW = shoulderW * 0.22;
  const thighs: Quad[] = [];
  const shins: Quad[] = [];
  for (const side of ['left', 'right'] as const) {
    const hip = p[`${side}Hip`];
    const knee = p[`${side}Knee`];
    const ankle = p[`${side}Ankle`];
    if (hip && knee) thighs.push(limbQuad(hip, knee, legW));
    if (knee && ankle) shins.push(limbQuad(knee, ankle, legW * 0.8));
  }
  if (thighs.length) out.thighs = thighs;
  if (shins.length) out.shins = shins;
  const ears = p.leftEar && p.rightEar ? [p.leftEar, p.rightEar] : null;
  const eyes = p.leftEye && p.rightEye ? [p.leftEye, p.rightEye] : null;
  const anchor = ears ?? eyes;
  if (anchor) {
    const w = Math.max(dist(anchor[0], anchor[1]), shoulderW * 0.35);
    const c = mid(anchor[0], anchor[1]);
    const topY = c[1] - w * 1.15;
    const botY = c[1] - w * 0.35;
    out.hair = [
      [
        [c[0] - w * 0.55, topY],
        [c[0] + w * 0.55, topY],
        [c[0] + w * 0.55, botY],
        [c[0] - w * 0.55, botY],
      ],
    ];
  }
  // Return normalized coordinates for sampling and overlays. Points are shared by some quads.
  for (const region of Object.keys(out) as (keyof OutfitSig)[]) {
    out[region] = out[region]!.map((q) => q.map(([x, y]): Pt => [x / aspect, y]) as Quad);
  }
  return out;
}

function hsvBin(r: number, g: number, b: number): number {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const v = max;
  const s = max === 0 ? 0 : (max - min) / max;
  if (s < 0.22 || v < 0.12) return 48 + (v < 0.3 ? 0 : v < 0.65 ? 1 : 2);
  const d = max - min;
  let h: number;
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  h = ((h * 60) + 360) % 360;
  const hb = Math.floor(h / 30) % 12;
  const sb = s < 0.55 ? 0 : 1;
  const vb = v < 0.55 ? 0 : 1;
  return hb * 4 + sb * 2 + vb;
}

/**
 * Spread each hue bin a little into its neighbours so a colour sitting on a bin edge, or shifted
 * slightly by lighting, still overlaps with itself. Grey bins are left alone.
 */
function smoothHues(hist: Float32Array): Float32Array {
  const out = new Float32Array(SIG_LEN);
  for (let hb = 0; hb < 12; hb++) {
    for (let sv = 0; sv < 4; sv++) {
      const i = hb * 4 + sv;
      const prev = ((hb + 11) % 12) * 4 + sv;
      const next = ((hb + 1) % 12) * 4 + sv;
      out[i] += hist[i] * 0.7;
      out[prev] += hist[i] * 0.15;
      out[next] += hist[i] * 0.15;
    }
  }
  for (let i = 48; i < SIG_LEN; i++) out[i] = hist[i];
  return out;
}

function sampleQuad(img: ImageData, quad: Quad, hist: Float32Array, minPixels: number, G = 14): number {
  if (!convexQuad(quad)) return 0;
  const [ls, rs, rh, lh] = quad;
  const pixels = new Set<number>();
  let visible = 0;
  for (let i = 0; i < G; i++) {
    const u = 0.15 + (0.7 * (i + 0.5)) / G;
    for (let j = 0; j < G; j++) {
      const v = 0.15 + (0.7 * (j + 0.5)) / G;
      const tx = ls[0] + (rs[0] - ls[0]) * u;
      const ty = ls[1] + (rs[1] - ls[1]) * u;
      const bx = lh[0] + (rh[0] - lh[0]) * u;
      const by = lh[1] + (rh[1] - lh[1]) * u;
      const x = Math.round((tx + (bx - tx) * v) * (img.width - 1));
      const y = Math.round((ty + (by - ty) * v) * (img.height - 1));
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const k = (y * img.width + x) * 4;
      if (img.data[k + 3] === 0) continue;
      visible++;
      pixels.add(k);
    }
  }
  // A tiny or mostly clipped patch can repeat one background pixel hundreds of times and appear certain.
  if (visible < G * G * 0.8 || pixels.size < minPixels) return 0;
  for (const k of pixels) hist[hsvBin(img.data[k], img.data[k + 1], img.data[k + 2])]++;
  return pixels.size;
}

/** Colour histogram of one or more quads sampled from a small frame. */
function regionSignature(img: ImageData, quads: Quad[], minPixels: number): number[] | null {
  const hist = new Float32Array(SIG_LEN);
  let n = 0;
  for (const q of quads) n += sampleQuad(img, q, hist, minPixels);
  if (n === 0) return null;
  const sm = smoothHues(hist);
  return Array.from(sm, (v) => roundTo(v / n, 4));
}

/** Every visible clothing region of one body in one frame. */
export function outfitSignature(img: ImageData, body: BodyResult, minScore = 0.4): OutfitSig | null {
  if (img.width < 2 || img.height < 2 || img.data.length < img.width * img.height * 4) return null;
  const regions = outfitRegions(body, minScore, img.width / img.height);
  if (!regions.top) return null;
  const top = regionSignature(img, regions.top, 32);
  if (!top) return null;
  const sig: OutfitSig = { top };
  for (const region of ['thighs', 'shins', 'hair'] as const) {
    const quads = regions[region];
    const sample = quads ? regionSignature(img, quads, 12) : null;
    if (sample) sig[region] = sample;
  }
  return sig;
}

/** A region signature that carries no measurement (missing, empty, or all zeros) says nothing either way. */
const hasSignal = (s: number[] | undefined): s is number[] => Boolean(s && s.length && s.some((v) => v > 0));

/** Whether a profile has any measured outfit region on either side (an outfit veto can only protect those that do). */
export function hasOutfit(outfit: OutfitSides | null | undefined): boolean {
  if (!outfit) return false;
  return [outfit.front, outfit.back].some((side) => side && ((['top', 'thighs', 'shins', 'hair'] as (keyof OutfitSig)[])).some((k) => hasSignal(side[k])));
}

/** Histogram intersection in 0..1. */
function sigSimilarity(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.min(a[i], b[i]);
  return s;
}

function averageSigs(sigs: number[][]): number[] {
  const out = new Array(SIG_LEN).fill(0);
  if (sigs.length === 0) return out;
  for (const s of sigs) for (let i = 0; i < SIG_LEN; i++) out[i] += s[i] ?? 0;
  return out.map((v) => roundTo(v / sigs.length, 4));
}

/** Average of several outfit samples, region by region, using each region only where it was seen. */
export function averageOutfits(samples: OutfitSig[]): OutfitSig {
  const pick = (k: keyof OutfitSig) => samples.map((s) => s[k]).filter((v): v is number[] => Boolean(v));
  const out: OutfitSig = { top: averageSigs(pick('top')) };
  for (const k of ['thighs', 'shins', 'hair'] as const) {
    const vals = pick(k);
    if (vals.length >= Math.max(1, samples.length * 0.4)) out[k] = averageSigs(vals);
  }
  return out;
}

/** How much each region counts. The top is largest and most visible; hair is small but rarely shared. */
const REGION_WEIGHT: Record<keyof OutfitSig, number> = { top: 0.45, thighs: 0.25, shins: 0.1, hair: 0.2 };

export interface OutfitMatch {
  /** Weighted similarity over the regions both signatures have. */
  sim: number;
  /** Share of the outfit weight those regions carry (1 = every region compared). */
  coverage: number;
  /** Whether the trousers were among the compared regions. */
  thighs: boolean;
}

/**
 * A region this dissimilar is a different garment, whatever the rest of the outfit says: the same
 * clothes measured 0.86 to 0.97 whole-outfit similarity from 2 to 8 m, and a same-hue garment of
 * another shade scores about 0.35. Hair and shins are small and lighting-sensitive, so only a
 * near-total mismatch of those counts.
 */
const REGION_CONTRADICTION: Record<keyof OutfitSig, number> = { top: 0.4, thighs: 0.4, shins: 0.2, hair: 0.2 };

/**
 * Weighted similarity over the regions both signatures have, and how much of the outfit that is. A
 * clearly different top or trousers caps the whole match below the evidence floor: the same shirt on
 * different legs is not the same outfit, and a weighted average must not let the shirt outvote them.
 */
function outfitMatch(a: OutfitSig, b: OutfitSig): OutfitMatch {
  let num = 0;
  let den = 0;
  let contradiction = false;
  for (const k of Object.keys(REGION_WEIGHT) as (keyof OutfitSig)[]) {
    const x = a[k];
    const y = b[k];
    // An unmeasured region (a profile enrolled without the hips in view) is unknown, never a contradiction.
    if (!hasSignal(x) || !hasSignal(y)) continue;
    const s = sigSimilarity(x, y);
    if (s < REGION_CONTRADICTION[k]) contradiction = true;
    num += REGION_WEIGHT[k] * s;
    den += REGION_WEIGHT[k];
  }
  const sim = den === 0 ? 0 : num / den;
  return { sim: contradiction ? Math.min(sim, REGION_CONTRADICTION_CAP) : sim, coverage: den, thighs: hasSignal(a.thighs) && hasSignal(b.thighs) };
}

function outfitSimilarity(a: OutfitSig, b: OutfitSig): number {
  return outfitMatch(a, b).sim;
}

/** Best match of a live outfit against a player's front or back, with the coverage of that side. */
export function profileOutfitMatch(sig: OutfitSig, outfit: OutfitSides): OutfitMatch {
  const f = outfitMatch(sig, outfit.front);
  const b = outfitMatch(sig, outfit.back);
  return f.sim >= b.sim ? f : b;
}

/** Best match of a live outfit against a player's front or back. */
export function profileOutfitSim(sig: OutfitSig, outfit: OutfitSides): number {
  return profileOutfitMatch(sig, outfit).sim;
}

/** Highest similarity between any of two players' front/back outfits. */
export function outfitConflict(a: OutfitSides, b: OutfitSides): number {
  return Math.max(
    outfitSimilarity(a.front, b.front),
    outfitSimilarity(a.front, b.back),
    outfitSimilarity(a.back, b.front),
    outfitSimilarity(a.back, b.back),
  );
}

/**
 * Scale-free body ratios. Only meaningful when the body is roughly square to the camera, which
 * is true for the enrollment scans and for most shots at range.
 */
export function bodyProportions(body: BodyResult, minScore = 0.4): BodyProps | null {
  // positionRaw normalizes each axis separately, so its ratios change when the camera rotates.
  const p = keypoints(body, minScore, true);
  if (!p.leftShoulder || !p.rightShoulder || !p.leftHip || !p.rightHip) return null;
  const torso = quadOf(p, 'leftShoulder', 'rightShoulder', 'rightHip', 'leftHip');
  if (!torso || !convexQuad(torso)) return null;
  const shoulderW = dist(p.leftShoulder, p.rightShoulder);
  const hipW = dist(p.leftHip, p.rightHip);
  const torsoL = dist(mid(p.leftShoulder, p.rightShoulder), mid(p.leftHip, p.rightHip));
  if (shoulderW < 8 || torsoL < 8) return null;
  const legs: number[] = [];
  for (const side of ['left', 'right'] as const) {
    const hip = p[`${side}Hip`];
    const knee = p[`${side}Knee`];
    const ankle = p[`${side}Ankle`];
    if (hip && knee && ankle) legs.push(dist(hip, knee) + dist(knee, ankle));
  }
  if (legs.length === 0) return null;
  const legL = legs.reduce((a, b) => a + b, 0) / legs.length;
  const headW = p.leftEar && p.rightEar ? dist(p.leftEar, p.rightEar) : p.leftEye && p.rightEye ? dist(p.leftEye, p.rightEye) * 2.2 : 0;
  const r = (v: number) => roundTo(v, 3);
  return { shoulderTorso: r(shoulderW / torsoL), hipShoulder: r(hipW / shoulderW), legTorso: r(legL / torsoL), headShoulder: r(headW / shoulderW) };
}

export function averageProps(list: BodyProps[]): BodyProps | null {
  if (list.length === 0) return null;
  const keys = ['shoulderTorso', 'hipShoulder', 'legTorso', 'headShoulder'] as const;
  const out = {} as BodyProps;
  for (const k of keys) {
    const vals = list.map((b) => b[k]).filter((v) => v > 0);
    out[k] = vals.length ? roundTo(vals.reduce((a, b) => a + b, 0) / vals.length, 3) : 0;
  }
  return out;
}

/** Spread of each ratio across people, so differences can be turned into 0..1 similarity. */
const PROP_SCALE: Record<keyof BodyProps, number> = { shoulderTorso: 0.12, hipShoulder: 0.1, legTorso: 0.25, headShoulder: 0.06 };

/** 0..1 similarity between two sets of body ratios, 1 meaning identical. */
export function propsSimilarity(a: BodyProps, b: BodyProps): number {
  let sum = 0;
  let n = 0;
  for (const k of Object.keys(PROP_SCALE) as (keyof BodyProps)[]) {
    if (!a[k] || !b[k]) continue;
    const z = (a[k] - b[k]) / PROP_SCALE[k];
    sum += Math.exp(-0.5 * z * z);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/** Width of the frame copy used for clothing pixels. Sampling itself is a fixed grid per region, so
 * this only sets how many distinct pixels a distant torso can offer: at 192 a player 8 m away was a
 * 6 by 10 px patch and the outfit read as noise; at 384 it has four times the pixels. */
export const SAMPLE_WIDTH = 384;

/** Grabs a small copy of the video frame for pixel sampling. */
export class FrameSampler {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  grab(source: HTMLVideoElement | HTMLCanvasElement, width = SAMPLE_WIDTH): ImageData | null {
    const sourceWidth = 'videoWidth' in source ? source.videoWidth : source.width;
    const sourceHeight = 'videoHeight' in source ? source.videoHeight : source.height;
    if (!sourceWidth || !sourceHeight || !Number.isFinite(width) || width < 2) return null;
    width = Math.round(width);
    const h = Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
    if (this.canvas.width !== width || this.canvas.height !== h) {
      this.canvas.width = width;
      this.canvas.height = h;
    }
    this.ctx.drawImage(source, 0, 0, width, h);
    return this.ctx.getImageData(0, 0, width, h);
  }
}
