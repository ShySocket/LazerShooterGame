import type { BodyProps, OutfitSig, Profile } from '../types';
import { UNKNOWN_ID } from '../types';
import { profileOutfitSim, propsSimilarity } from './clothing';
import type { Track } from './tracker';
import { unitSimilarity } from './human';

export interface Candidate {
  id: string;
  profile: Profile;
}

/** Similarity values below `reject` mean a different person, above `accept` the same person. Model specific. */
export interface FaceCalib {
  reject: number;
  accept: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Face similarity per candidate mapped to 0..1 evidence. The pseudo-candidate UNKNOWN_ID gets the
 * evidence that nobody matched well, so a lone weak match has to beat "a stranger" before it locks.
 */
export function faceEvidence(
  embedding: number[],
  cands: Candidate[],
  sim: (a: number[], b: number[]) => number,
  calib: FaceCalib,
): Record<string, number> {
  const ev: Record<string, number> = {};
  let top = 0;
  for (const c of cands) {
    let best = 0;
    for (const f of c.profile.face ?? []) best = Math.max(best, sim(embedding, f));
    ev[c.id] = clamp01((best - calib.reject) / (calib.accept - calib.reject));
    top = Math.max(top, ev[c.id]);
  }
  ev[UNKNOWN_ID] = clamp01(1 - top);
  return ev;
}

/** Outfit similarity per candidate mapped to 0..1 evidence, plus the stranger baseline. */
export function clothingEvidence(sig: OutfitSig, cands: Candidate[]): Record<string, number> {
  const ev: Record<string, number> = {};
  let top = 0;
  for (const c of cands) {
    const raw = c.profile.outfit ? profileOutfitSim(sig, c.profile.outfit) : 0;
    ev[c.id] = clamp01((raw - 0.45) / 0.35);
    top = Math.max(top, ev[c.id]);
  }
  ev[UNKNOWN_ID] = clamp01(0.9 - top);
  return ev;
}

/** Body ratio similarity per candidate. Weak on its own, so it never produces an unknown vote. */
export function bodyEvidence(props: BodyProps, cands: Candidate[]): Record<string, number> {
  const ev: Record<string, number> = {};
  for (const c of cands) ev[c.id] = c.profile.body ? propsSimilarity(props, c.profile.body) : 0;
  return ev;
}

export interface Signals {
  face: Record<string, number> | null;
  cloth: Record<string, number> | null;
  body: Record<string, number> | null;
}

const W = { face: 0.6, cloth: 0.3, body: 0.1 };

/** Weighted mix of whatever signals were available this frame. Without a face the total is capped. */
export function combineEvidence(sig: Signals): Record<string, number> | null {
  const present = (Object.keys(W) as (keyof Signals)[]).filter((k) => sig[k]);
  if (present.length === 0) return null;
  const ids = new Set<string>();
  for (const k of present) Object.keys(sig[k]!).forEach((id) => ids.add(id));
  const den = present.reduce((s, k) => s + W[k], 0);
  const cap = sig.face ? 1 : 0.85;
  const out: Record<string, number> = {};
  for (const id of ids) {
    let num = 0;
    for (const k of present) {
      const v = sig[k]![id];
      // Unknown only speaks through face and clothing; body ratios abstain.
      if (v === undefined) {
        if (id === UNKNOWN_ID && k === 'body') num += W[k] * 0.5;
        continue;
      }
      num += W[k] * v;
    }
    out[id] = cap * (num / den);
  }
  return out;
}

/** How fast the running face mean follows new frames once it has a few samples. */
const MEAN_ALPHA = 0.3;
/** A new frame this dissimilar to the mean means the track switched person; start the mean over. */
const MEAN_RESET_SIM = 0.2;

/**
 * Fold one unit embedding into the track's running mean and return the mean. Matching against the
 * mean instead of each frame turns many noisy frames into one clean one.
 */
export function updateFaceMean(track: Track, emb: number[]): number[] {
  const m = track.faceMean;
  if (!m || m.length !== emb.length || unitSimilarity(m, emb) < MEAN_RESET_SIM) {
    track.faceMean = emb.slice();
    track.faceSamples = 1;
    return track.faceMean;
  }
  const a = Math.max(MEAN_ALPHA, 1 / (track.faceSamples + 1));
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    m[i] = (1 - a) * m[i] + a * emb[i];
    n += m[i] * m[i];
  }
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < m.length; i++) m[i] *= inv;
  track.faceSamples++;
  return m;
}

/**
 * One body per player. Claims are granted strongest first, each track taking one identity; an
 * identity owned by another track is dropped from a track's claimable beliefs, so the loser falls
 * through to its next-best candidate (or the stranger baseline) instead of also reading as that player.
 */
export function assignIdentities(tracks: Track[], exclusive: Set<string>): void {
  const claims: { t: Track; id: string; v: number }[] = [];
  for (const t of tracks) for (const [id, v] of Object.entries(t.belief)) if (exclusive.has(id)) claims.push({ t, id, v });
  claims.sort((a, b) => b.v - a.v);
  const ownerOf = new Map<string, Track>();
  const taken = new Set<Track>();
  for (const c of claims) {
    if (ownerOf.has(c.id) || taken.has(c.t)) continue;
    ownerOf.set(c.id, c.t);
    taken.add(c.t);
  }
  for (const t of tracks) {
    const claimed: Record<string, number> = {};
    for (const [id, v] of Object.entries(t.belief)) {
      const owner = ownerOf.get(id);
      if (!owner || owner === t) claimed[id] = v;
    }
    t.claimed = claimed;
  }
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

/**
 * The strongest belief on the track, whoever it is. The runner-up is drawn from every candidate,
 * including the shooter's own decoy profile and the stranger baseline, so a hit must beat those too.
 */
export function topBelief(track: Track): Resolution | null {
  const entries = Object.entries(track.claimed ?? track.belief).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const [id, score] = entries[0];
  const second = entries[1];
  return { id, score, margin: score - (second?.[1] ?? 0), via: track.via };
}

/** Best eligible player, for the live label. Null when the top belief is not a shootable player. */
export function bestBelief(track: Track, eligible: Set<string>): Resolution | null {
  const t = topBelief(track);
  return t && eligible.has(t.id) ? t : null;
}

/** A hit only registers when the top candidate is a live opponent, confident, and clearly ahead of everyone else. */
export function resolveHit(track: Track, eligible: Set<string>, threshold: number, margin: number): Resolution | null {
  const b = bestBelief(track, eligible);
  if (!b || b.score < threshold || b.margin < margin) return null;
  return b;
}
