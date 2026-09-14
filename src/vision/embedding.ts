import { roundTo } from '../util/num';
import { FACE_MEAN } from './faceMean';

/** Square-padded InsightFace embeddings; older distorted scans must be repeated. */
export const FACE_MODEL = 'insightface-mobilenet-swish-sq';
export const FACE_EMBEDDING_SIZE = 512;
/**
 * Thresholds on the mean-centred cosine (see centredSimilarity). Measured on 2026-09-13 over 61 faces
 * through the game's crop pipeline: strangers median -0.03, 90th percentile 0.20, 99th 0.39; a face
 * against a downscaled copy of itself 0.92 at 28 px and 0.99 at 60 px. Raw cosine on this model is
 * unusable as an absolute score (strangers median 0.4, up to 0.8) because every embedding shares
 * one dominant direction. `reject` sits above the stranger 90th percentile, `accept` well above the 99th.
 */
export const FACE_CALIB = { reject: 0.25, accept: 0.55 };
/** Two centred embeddings this similar are the same person for enrolment sanity checks. */
export const SAME_PERSON_MIN = 0.35;
/** Two players whose scans are this alike will be confused at range; the lobby warns. */
export const FACE_CONFLICT = 0.45;
/** Faces smaller than this in the full frame are too blurred for a trustworthy embedding. */
export const MIN_FACE_PX = 34;
/** Above this size a face embedding gets full weight; between, blur discounts it. */
export const FULL_QUALITY_FACE_PX = 56;

/** 0..1 confidence discount for a face of `px` pixels: a 30 px face keeps only ~0.7 of its similarity. */
export function faceQuality(px: number): number {
  if (!Number.isFinite(px) || px < MIN_FACE_PX) return 0;
  return Math.max(0, Math.min(1, (px - MIN_FACE_PX) / (FULL_QUALITY_FACE_PX - MIN_FACE_PX)));
}
export const MAX_YAW_DEG = 45;

/** Reject corrupt, missing, wrong-model, or zero-vector profile samples. */
export function isValidEmbedding(e: unknown, size = FACE_EMBEDDING_SIZE): e is number[] {
  if (!Array.isArray(e) || e.length !== size || size === 0) return false;
  let norm = 0;
  for (const v of e) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    norm += v * v;
  }
  return Number.isFinite(norm) && norm > 0;
}

/** Scale a raw embedding to unit length; invalid vectors carry no identity evidence. */
export function unitEmbedding(e: number[]): number[] {
  if (!isValidEmbedding(e, e.length)) return [];
  let norm = 0;
  for (const v of e) norm += v * v;
  const inv = 1 / Math.sqrt(norm);
  return e.map((v) => v * inv);
}

/** Cosine similarity of unit vectors, clamped to 0..1. Different lengths cannot match. */
export function unitSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Number.isFinite(dot) ? Math.max(0, Math.min(1, dot)) : 0;
}

const centred = new WeakMap<number[], number[]>();

/**
 * Remove the direction every face shares, then renormalise. Embeddings of the wrong length (tests,
 * other models) pass through unchanged. Results are cached per array, so stored profile samples
 * are centred once.
 */
export function centreUnit(e: number[]): number[] {
  if (e.length !== FACE_MEAN.length) return e;
  const hit = centred.get(e);
  if (hit) return hit;
  let norm = 0;
  const out = new Array<number>(e.length);
  for (let i = 0; i < e.length; i++) {
    out[i] = e[i] - FACE_MEAN[i];
    norm += out[i] * out[i];
  }
  const inv = norm > 0 ? 1 / Math.sqrt(norm) : 0;
  for (let i = 0; i < out.length; i++) out[i] *= inv;
  centred.set(e, out);
  return out;
}

/** Cosine similarity of two unit embeddings after mean-centring, clamped to 0..1. */
export function centredSimilarity(a: number[], b: number[]): number {
  return unitSimilarity(centreUnit(a), centreUnit(b));
}

export function faceSimilarity(a: number[], b: number[]): number {
  return centredSimilarity(unitEmbedding(a), unitEmbedding(b));
}

export function compactEmbedding(e: number[]): number[] {
  return unitEmbedding(e).map((v) => roundTo(v, 4));
}

/** Missing or invalid angles provide no reliable frontal-face evidence. */
export function faceYawDeg(f: { rotation?: { angle?: { yaw?: number } } | null }): number {
  const yaw = f.rotation?.angle?.yaw;
  return typeof yaw === 'number' && Number.isFinite(yaw) ? Math.abs(yaw * 180 / Math.PI) : Infinity;
}

/** Head angles captured by a face scan. A shorter stored set cannot stand in for a fresh scan. */
export const FACE_SAMPLES = 8;

/** A stored face scan is usable only when it comes from this model, is complete, and every vector is intact. */
export function isCurrentFaceScan(scan: { faceModel?: string; face?: unknown } | null | undefined): boolean {
  return Boolean(
    scan && scan.faceModel === FACE_MODEL && Array.isArray(scan.face) && scan.face.length >= FACE_SAMPLES && scan.face.every((sample) => isValidEmbedding(sample)),
  );
}
