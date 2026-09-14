import type { BodyProps, OutfitSig, Profile } from '../types';
import { EVIDENCE_WEIGHTS, IDENTITY_TTL_MS, MEAN_ALPHA, MEAN_RESET_SIM, STRANGER_BASELINE } from './calibration';
import { BODY_MODEL, UNKNOWN_ID } from '../types';
import { profileOutfitMatch, propsSimilarity } from './clothing';
import { resetIdentity, type Track } from './tracker';
import { centredSimilarity } from './embedding';

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
  quality = 1,
): Record<string, number> {
  const ev: Record<string, number> = {};
  let top = 0;
  // A small, blurred face may still name somebody, but never with full confidence, and its failure
  // to match is equally uncertain: the stranger vote shrinks with it rather than winning by default.
  const weight = 0.6 + 0.4 * clamp01(quality);
  for (const c of cands) {
    let best = 0;
    for (const f of c.profile.face ?? []) best = Math.max(best, sim(embedding, f));
    ev[c.id] = clamp01((best - calib.reject) / (calib.accept - calib.reject));
    top = Math.max(top, ev[c.id]);
  }
  for (const id of Object.keys(ev)) ev[id] *= weight;
  ev[UNKNOWN_ID] = weight * clamp01(1 - top);
  return ev;
}

/**
 * Outfit similarity per candidate mapped to 0..1 evidence, plus the stranger baseline. Similarity is
 * measured over the clothing regions both sides have, so it is scaled by how much of the outfit that
 * covers: a matching shirt alone (coverage 0.45) cannot on its own reach the hit threshold, because
 * the regions that would tell a stranger in the same shirt apart were never compared.
 */
export function clothingEvidence(sig: OutfitSig, cands: Candidate[], established?: Record<string, number>): Record<string, number> {
  const ev: Record<string, number> = {};
  let top = 0;
  for (const c of cands) {
    const m = c.profile.outfit ? profileOutfitMatch(sig, c.profile.outfit) : { sim: 0, coverage: 0, thighs: false };
    const raw = clamp01((m.sim - 0.45) / 0.35);
    // Acquiring an identity from clothing needs the trousers compared as well as the top: a shirt
    // plus hair can be shared with a stranger, and whatever was not seen cannot tell them apart.
    // Partial coverage does not erode an identity already established while the visible regions
    // keep matching.
    const factor = Math.min(m.thighs ? 1 : 0.55, 0.2 + 0.8 * m.coverage);
    const scaled = raw * factor;
    ev[c.id] = Math.max(scaled, Math.min(established?.[c.id] ?? 0, raw));
    top = Math.max(top, scaled);
  }
  // The stranger vote is what a partial match must beat by the hit margin: a shirt plus a
  // mismatching hairline reaches about 0.55 and stays within the margin of this baseline.
  ev[UNKNOWN_ID] = clamp01(STRANGER_BASELINE - top);
  return ev;
}

/** Body ratio similarity per candidate. Weak on its own, so it never produces an unknown vote. */
export function bodyEvidence(props: BodyProps, cands: Candidate[]): Record<string, number> {
  const ev: Record<string, number> = {};
  for (const c of cands) {
    if (c.profile.body && c.profile.bodyModel === BODY_MODEL) ev[c.id] = propsSimilarity(props, c.profile.body);
  }
  return ev;
}

export interface Signals {
  face: Record<string, number> | null;
  cloth: Record<string, number> | null;
  body: Record<string, number> | null;
}

const W = EVIDENCE_WEIGHTS;

/** Weighted mix of whatever signals were available this frame. Without a face the total is capped. */
export function combineEvidence(sig: Signals): Record<string, number> | null {
  // Body proportions are shared by many people. They may break an outfit tie, never identify alone.
  if (!sig.face && !sig.cloth) return null;
  // A signal with nothing to say (no stored reference for anybody) is absent, not a zero vote.
  const present = (Object.keys(W) as (keyof Signals)[]).filter((k) => sig[k] && Object.keys(sig[k]!).length > 0);
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

/**
 * Fold one unit embedding into the track's running mean and return the mean. Matching against the
 * mean instead of each frame turns many noisy frames into one clean one.
 */
export function updateFaceMean(track: Track, emb: number[]): number[] {
  const m = track.faceMean;
  if (!m || m.length !== emb.length || centredSimilarity(m, emb) < MEAN_RESET_SIM) {
    if (m) resetIdentity(track);
    track.faceMean = emb.slice();
    track.faceSamples = 1;
    return track.faceMean;
  }
  // A fresh array every update: centredSimilarity caches per array identity, so mutating the mean in
  // place would keep serving the similarity of an old mean.
  const a = Math.max(MEAN_ALPHA, 1 / (track.faceSamples + 1));
  const next = new Array<number>(m.length);
  let n = 0;
  for (let i = 0; i < m.length; i++) {
    next[i] = (1 - a) * m[i] + a * emb[i];
    n += next[i] * next[i];
  }
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < m.length; i++) next[i] *= inv;
  track.faceMean = next;
  track.faceSamples++;
  return next;
}

/**
 * One body per player. Only a track's actual first choice can claim an identity. Keep every competing
 * belief when computing the margin: another person's presence is not evidence for a weaker match.
 */
export function assignIdentities(tracks: Track[], exclusive: Set<string>): void {
  const claims = new Map<string, { t: Track; v: number }[]>();
  for (const t of tracks) {
    t.claimed = { ...t.belief };
    t.identityConflict = false;
    const top = topBelief(t);
    if (top && exclusive.has(top.id)) claims.set(top.id, [...(claims.get(top.id) ?? []), { t, v: top.score }]);
  }
  for (const list of claims.values()) {
    list.sort((a, b) => b.v - a.v);
    for (let i = 1; i < list.length; i++) list[i].t.identityConflict = true;
    // Near-equal duplicate claims have no defensible winner.
    if (list.length > 1 && list[0].v - list[1].v < 0.15) list[0].t.identityConflict = true;
  }
}

export function updateBelief(track: Track, ev: Record<string, number>, alpha = 0.35, now = performance.now()): void {
  for (const id of new Set([...Object.keys(track.belief), ...Object.keys(ev)])) {
    const v = Number.isFinite(ev[id]) ? clamp01(ev[id]) : 0;
    track.belief[id] = (1 - alpha) * (track.belief[id] ?? 0) + alpha * v;
  }
  track.lastEvidenceAt = now;
  track.claimed = null;
  // Fresh evidence on this body is what an ambiguous frame was waiting for.
  track.unconfirmed = false;
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
  return t && !track.identityConflict && eligible.has(t.id) ? t : null;
}

export { IDENTITY_TTL_MS };

/** A hit only registers when the top candidate is a live opponent, confident, and clearly ahead of everyone else. */
export function resolveHit(track: Track, eligible: Set<string>, threshold: number, margin: number, now = performance.now()): Resolution | null {
  if (!Number.isFinite(track.lastEvidenceAt) || now < track.lastEvidenceAt || now - track.lastEvidenceAt > IDENTITY_TTL_MS) return null;
  // After a frame that could not tell whose face was whose, the identity waits for fresh evidence.
  if (track.unconfirmed) return null;
  const b = bestBelief(track, eligible);
  if (!b || !Number.isFinite(b.score) || !Number.isFinite(b.margin) || b.score < threshold || b.margin < margin || b.margin <= 0) return null;
  return b;
}
