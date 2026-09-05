import type { BodyResult } from '@vladmandic/human';
import type { TorsoSig } from '../types';

/** 12 hues x 2 saturation x 2 value bins, plus 3 grey bins. */
export const SIG_LEN = 51;

const TORSO_PARTS = ['leftShoulder', 'rightShoulder', 'rightHip', 'leftHip'] as const;
type Pt = [number, number];

/** Torso quad in normalised coordinates, or null if the torso is not visible enough. */
export function torsoQuad(body: BodyResult, minScore = 0.3): [Pt, Pt, Pt, Pt] | null {
  const pts: Partial<Record<(typeof TORSO_PARTS)[number], Pt>> = {};
  for (const kp of body.keypoints) {
    const part = kp.part as (typeof TORSO_PARTS)[number];
    if (TORSO_PARTS.includes(part) && kp.score >= minScore) pts[part] = [kp.positionRaw[0], kp.positionRaw[1]];
  }
  if (TORSO_PARTS.some((p) => !pts[p])) return null;
  return [pts.leftShoulder!, pts.rightShoulder!, pts.rightHip!, pts.leftHip!];
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

/** Colour histogram of the torso region sampled from a small frame. */
export function torsoSignature(img: ImageData, quad: [Pt, Pt, Pt, Pt]): number[] {
  const [ls, rs, rh, lh] = quad;
  const hist = new Float32Array(SIG_LEN);
  let n = 0;
  const G = 14;
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
      hist[hsvBin(img.data[k], img.data[k + 1], img.data[k + 2])]++;
      n++;
    }
  }
  if (n === 0) return new Array(SIG_LEN).fill(0);
  return Array.from(hist, (v) => Math.round((v / n) * 10000) / 10000);
}

/** Histogram intersection in 0..1. */
export function sigSimilarity(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += Math.min(a[i], b[i]);
  return s;
}

export function averageSigs(sigs: number[][]): number[] {
  const out = new Array(SIG_LEN).fill(0);
  if (sigs.length === 0) return out;
  for (const s of sigs) for (let i = 0; i < SIG_LEN; i++) out[i] += s[i] ?? 0;
  return out.map((v) => Math.round((v / sigs.length) * 10000) / 10000);
}

export function profileClothSim(sig: number[], torso: TorsoSig): number {
  return Math.max(sigSimilarity(sig, torso.front), sigSimilarity(sig, torso.back));
}

/** Highest similarity between any of two players' front/back signatures. */
export function torsoConflict(a: TorsoSig, b: TorsoSig): number {
  return Math.max(
    sigSimilarity(a.front, b.front),
    sigSimilarity(a.front, b.back),
    sigSimilarity(a.back, b.front),
    sigSimilarity(a.back, b.back),
  );
}

/** Grabs a small copy of the video frame for pixel sampling. */
export class FrameSampler {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  grab(video: HTMLVideoElement, width = 192): ImageData | null {
    if (!video.videoWidth || !video.videoHeight) return null;
    const h = Math.max(1, Math.round((width * video.videoHeight) / video.videoWidth));
    if (this.canvas.width !== width || this.canvas.height !== h) {
      this.canvas.width = width;
      this.canvas.height = h;
    }
    this.ctx.drawImage(video, 0, 0, width, h);
    return this.ctx.getImageData(0, 0, width, h);
  }
}
