import type { Profile } from '../types';
import { profileClothSim } from './clothing';
import type { Track } from './tracker';

export interface Candidate {
  id: string;
  profile: Profile;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Face similarity per candidate mapped to 0..1 evidence. Human says > 0.5 is a match. */
export function faceEvidence(
  embedding: number[],
  cands: Candidate[],
  sim: (a: number[], b: number[]) => number,
): Record<string, number> {
  const ev: Record<string, number> = {};
  for (const c of cands) {
    let best = 0;
    for (const f of c.profile.face ?? []) best = Math.max(best, sim(embedding, f));
    ev[c.id] = clamp01((best - 0.45) / 0.3);
  }
  return ev;
}

/** Clothing similarity per candidate mapped to 0..1 evidence. */
export function clothingEvidence(sig: number[], cands: Candidate[]): Record<string, number> {
  const ev: Record<string, number> = {};
  for (const c of cands) {
    const raw = c.profile.torso ? profileClothSim(sig, c.profile.torso) : 0;
    ev[c.id] = clamp01((raw - 0.45) / 0.35);
  }
  return ev;
}

export function combineEvidence(
  face: Record<string, number> | null,
  cloth: Record<string, number> | null,
): Record<string, number> | null {
  if (!face && !cloth) return null;
  const ids = new Set([...Object.keys(face ?? {}), ...Object.keys(cloth ?? {})]);
  const out: Record<string, number> = {};
  for (const id of ids) {
    const f = face?.[id] ?? 0;
    const c = cloth?.[id] ?? 0;
    if (face && cloth) out[id] = 0.7 * f + 0.3 * c;
    else if (face) out[id] = f;
    else out[id] = 0.85 * c;
  }
  return out;
}

export function updateBelief(track: Track, ev: Record<string, number>, alpha = 0.35): void {
  for (const [id, v] of Object.entries(ev)) {
    track.belief[id] = (1 - alpha) * (track.belief[id] ?? 0) + alpha * v;
  }
}

export interface Resolution {
  id: string;
  score: number;
  margin: number;
  via: string;
}

export function bestBelief(track: Track, eligible: Set<string>): Resolution | null {
  const entries = Object.entries(track.belief)
    .filter(([id]) => eligible.has(id))
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const [id, score] = entries[0];
  const second = entries[1]?.[1] ?? 0;
  return { id, score, margin: score - second, via: track.via };
}

/** A hit only registers when the top candidate is confident and clearly ahead. */
export function resolveHit(track: Track, eligible: Set<string>, threshold: number, margin: number): Resolution | null {
  const b = bestBelief(track, eligible);
  if (!b || b.score < threshold || b.margin < margin) return null;
  return b;
}
