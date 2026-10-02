import type { BodyProps, OutfitSig, Profile } from '../types';
import { BELIEF_MAX_STEPS, BELIEF_REF_PERIOD_MS, CLOTHING_EVIDENCE, EVIDENCE_WEIGHTS, IDENTITY_TTL_MS, LIVE_FACE_SAMPLE_SPACING_MS, MEAN_ALPHA, MEAN_RESET_SIM, FACE_ONLY_CALIB, OUTFIT_BACK_MIN, OUTFIT_RECENT_MS, OUTFIT_RIVAL_LEAD, OUTFIT_VETO, OVERLAP_FACE_FRESH_MS, REACQUIRE, STRANGER_BASELINE } from './calibration';
import { BODY_MODEL, UNKNOWN_ID } from '../types';
import { hasOutfit, profileOutfitMatch, propsSimilarity } from './clothing';
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
  cands: readonly Candidate[],
  sim: (a: number[], b: number[]) => number,
  calib: FaceCalib,
  quality = 1,
  corroborated: (id: string) => boolean = () => true,
): Record<string, number> {
  const ev: Record<string, number> = {};
  let top = 0;
  // A small, blurred face may still name somebody, but never with full confidence, and its failure
  // to match is equally uncertain: the stranger vote shrinks with it rather than winning by default.
  const weight = 0.6 + 0.4 * clamp01(quality);
  for (const c of cands) {
    let best = 0;
    for (const f of c.profile.face ?? []) best = Math.max(best, sim(embedding, f));
    // Without an outfit on file, or without their own outfit backing the face on this body lately,
    // nothing tells a look-alike stranger apart: the face must clear the stricter bar.
    const k = hasOutfit(c.profile.outfit) && corroborated(c.id) ? calib : FACE_ONLY_CALIB;
    ev[c.id] = clamp01((best - k.reject) / (k.accept - k.reject));
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
    const raw = clamp01((m.sim - CLOTHING_EVIDENCE.floor) / CLOTHING_EVIDENCE.span);
    // Acquiring an identity from clothing needs the trousers compared as well as the top: a shirt
    // plus hair can be shared with a stranger, and whatever was not seen cannot tell them apart.
    // Partial coverage does not erode an identity already established while the visible regions
    // keep matching.
    const factor = Math.min(m.thighs ? 1 : CLOTHING_EVIDENCE.noThighsCap, CLOTHING_EVIDENCE.coverageFloor + (1 - CLOTHING_EVIDENCE.coverageFloor) * m.coverage);
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
export function updateFaceMean(track: Track, emb: number[], now?: number): number[] {
  const m = track.faceMean;
  // Frames closer together than the spacing are the same moment seen twice: they refine the mean
  // but do not count as another independent sample for the live-enrolment gates.
  const independent = now === undefined || !(now - track.lastFaceSampleAt < LIVE_FACE_SAMPLE_SPACING_MS);
  if (!m || m.length !== emb.length || centredSimilarity(m, emb) < MEAN_RESET_SIM) {
    if (m) resetIdentity(track);
    track.faceMean = emb.slice();
    track.faceSamples = 1;
    track.lastFaceSampleAt = now ?? 0;
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
  if (independent) {
    track.faceSamples++;
    track.lastFaceSampleAt = now ?? 0;
  }
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

/** The per-reference-period step `alpha`, rescaled to an elapsed `dtMs`, capped at BELIEF_MAX_STEPS periods. */
export function elapsedAlpha(alpha: number, dtMs: number): number {
  const a = clamp01(alpha);
  if (a >= 1) return 1;
  const steps = Math.min(BELIEF_MAX_STEPS, Math.max(0, dtMs) / BELIEF_REF_PERIOD_MS);
  return 1 - Math.pow(1 - a, steps);
}

/**
 * Blend one frame of evidence into the belief. `alpha` is the step for one reference frame period;
 * the actual step follows the time since the last evidence, so the belief moves at the same
 * wall-clock rate on a 100 ms phone and a 400 ms phone, and a burst of near-duplicate frames is not
 * a burst of independent proof. The first evidence on a track takes the full step. `confirm` is the
 * evidence that may confirm a suspended identity, when that must be narrower than what moves the
 * belief (this frame's own face read rather than the running mean, pipeline.ts applyFace), or empty
 * when the evidence may move the belief but confirm nothing (an outfit read whose pixels may be a
 * hidden partner's).
 */
export function updateBelief(track: Track, ev: Record<string, number>, alpha = 0.35, now = performance.now(), confirm: Record<string, number> = ev): void {
  const a = elapsedAlpha(alpha, track.lastEvidenceAt > 0 && now > track.lastEvidenceAt ? now - track.lastEvidenceAt : BELIEF_REF_PERIOD_MS);
  // Fresh evidence confirms a suspended identity only when it agrees with it; evidence for somebody
  // else keeps the track unconfirmed until the belief itself has followed the evidence.
  const believed = Object.entries(track.belief).sort((x, y) => y[1] - x[1])[0]?.[0];
  const seen = Object.entries(confirm).sort((x, y) => y[1] - x[1])[0]?.[0];
  // Nothing to confirm with (an empty `confirm`) confirms nothing, whatever the belief.
  const agrees = seen !== undefined && (believed === undefined || seen === believed);
  for (const id of new Set([...Object.keys(track.belief), ...Object.keys(ev)])) {
    const v = Number.isFinite(ev[id]) ? clamp01(ev[id]) : 0;
    track.belief[id] = (1 - a) * (track.belief[id] ?? 0) + a * v;
  }
  track.lastEvidenceAt = now;
  track.claimed = null;
  if (agrees) track.unconfirmed = false;
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

/** A sample over more than the shirt that matches a player's scanned outfit well enough to lift a veto (OUTFIT_VETO). */
const clearOutfitMatch = (m: { sim: number; coverage: number }): boolean => m.coverage >= OUTFIT_VETO.clearCoverage && m.sim >= OUTFIT_VETO.clearSim;

/**
 * Players this track's own earlier reads ruled out (an active veto) whose outfit this sample clearly
 * matches. A body does not change clothes between two reads a moment apart, so a non-empty answer
 * means the track is now on somebody else's body, or one of the two reads was wrong.
 */
export function outfitReversals(track: Track, sig: OutfitSig, cands: Candidate[], now: number): string[] {
  return cands.filter((c) => c.profile.outfit && c.id !== UNKNOWN_ID && outfitVetoed(track, c.id, now) && clearOutfitMatch(profileOutfitMatch(sig, c.profile.outfit))).map((c) => c.id);
}

/**
 * Rule players out on this body when a well-covered outfit sample contradicts their scanned outfit,
 * and lift the veto when a later sample matches it again. See OUTFIT_VETO. Also records whom this
 * sample agrees with over what it compared (Track.outfitAgrees, for outfitSupports).
 *
 * A sample backs a player's face, or agrees with them, only when it is their outfit rather than
 * merely like it. It must match their scan at OUTFIT_BACK_MIN or better, and so must this body's
 * samples on average since its last uncertain transition, leaving out those that contradict them
 * (Track.outfitReads): `clearSim`, which lifts a veto, only says the sample does not contradict them,
 * and a suit like theirs clears it too. And no other player's scan, compared over as much of the
 * outfit, may match it better by more than OUTFIT_RIVAL_LEAD, in this sample or on average. A sample
 * that falls short on either count takes back the backing an earlier sample gave. Without the rival rule every suit backed every suited face
 * among players in similar suits, and a poor crop of one player that read a little like another was
 * judged at the normal bar for the other (realcheck antony-blinken/08, 2026-10-02: LOCK and a hit on
 * P1 with P2 under the dot); without the bar the same happened on anybody wearing a suit no player
 * enrolled (P2 left out of the candidates: a bystander, or a face-only practice target).
 */
export function updateOutfitVeto(track: Track, sig: OutfitSig, cands: Candidate[], now: number, mayCorroborate = true): void {
  const agrees: string[] = [];
  const matches = cands.filter((c) => c.profile.outfit && c.id !== UNKNOWN_ID).map((c) => ({ id: c.id, m: profileOutfitMatch(sig, c.profile.outfit!) }));
  /** The best match among the players compared over at least `coverage` of the outfit. */
  const best = (coverage: number) => Math.max(0, ...matches.filter(({ m }) => m.coverage >= coverage).map(({ m }) => m.sim));
  const bestTop = best(OUTFIT_VETO.minCoverage);
  const bestClear = best(OUTFIT_VETO.clearCoverage);
  // Whose outfit this body wears, over every readable sample since its last uncertain transition: a
  // single sample within the noise of two similar suits does not decide it, nor one lucky read of a
  // suit that only resembles a player's. A sample that may hold somebody else's pixels (an overlap) is
  // not this body's. How alike the outfit reads (OUTFIT_BACK_MIN) leaves out the samples that
  // contradict the player: those veto them on their own, and a sampler glitch (a bad crop, a light
  // change) would otherwise keep a player's own outfit from backing their face for many reads after.
  if (mayCorroborate) {
    for (const { id, m } of matches) {
      if (m.coverage < OUTFIT_VETO.clearCoverage) continue;
      const r = track.outfitReads?.[id] ?? { sum: 0, n: 0, fitSum: 0, fit: 0 };
      const fits = m.sim > OUTFIT_VETO.maxSim;
      track.outfitReads = { ...track.outfitReads, [id]: { sum: r.sum + m.sim, n: r.n + 1, fitSum: r.fitSum + (fits ? m.sim : 0), fit: r.fit + (fits ? 1 : 0) } };
    }
  }
  const meanOf = (id: string): number | null => {
    const r = track.outfitReads?.[id];
    return r && r.n > 0 ? r.sum / r.n : null;
  };
  /** The same over the samples that did not contradict this player: how much like their scan this body's outfit reads. */
  const likenessOf = (id: string): number | null => {
    const r = track.outfitReads?.[id];
    return r && r.fit > 0 ? r.fitSum / r.fit : null;
  };
  const bestMean = Math.max(0, ...matches.map(({ id }) => meanOf(id) ?? 0));
  for (const { id, m } of matches) {
    if (m.coverage < OUTFIT_VETO.minCoverage) continue;
    if (m.sim >= OUTFIT_BACK_MIN && bestTop - m.sim <= OUTFIT_RIVAL_LEAD) agrees.push(id);
    const v = track.outfitVeto?.[id];
    if (m.sim <= OUTFIT_VETO.maxSim) {
      track.outfitVeto = { ...track.outfitVeto, [id]: { at: now, eased: false } };
      continue;
    }
    // Only a sample that covers more than the shirt can lift, ease or back up anything: a shirt alone
    // never compared the trousers that may have caused a veto, nor told a look-alike in the same top apart.
    if (m.coverage < OUTFIT_VETO.clearCoverage) continue;
    // Another player's scan explains this sample, or this body's samples so far, clearly better: it is
    // their outfit. Or this body's samples so far only resemble this player's scan (OUTFIT_BACK_MIN):
    // somebody else's outfit, whether or not anybody enrolled it. Either way it backs this player's face
    // no longer, whatever an earlier sample said (one sample within the noise of two similar suits would
    // otherwise back them for OUTFIT_RECENT_MS while every read since said otherwise).
    const mean = meanOf(id);
    const rivalled = bestClear - m.sim > OUTFIT_RIVAL_LEAD || (mean !== null && bestMean - mean > OUTFIT_RIVAL_LEAD);
    const likeness = likenessOf(id);
    const resembles = likeness !== null && likeness < OUTFIT_BACK_MIN;
    if (mayCorroborate && (rivalled || resembles) && track.outfitSupport?.[id] !== undefined) {
      const { [id]: _revoked, ...others } = track.outfitSupport;
      track.outfitSupport = others;
    }
    if (clearOutfitMatch(m)) {
      if (v) {
        const { [id]: _gone, ...rest } = track.outfitVeto!;
        track.outfitVeto = rest;
      }
      // Lifting a veto needs only a clear match: the sample does not contradict this player. Backing
      // their face needs it to be their outfit: matched at the backing bar, by this sample and by this
      // body's samples on average, and not a rival's that it matches clearly better.
      if (mayCorroborate && !rivalled && !resembles && m.sim >= OUTFIT_BACK_MIN) track.outfitSupport = { ...track.outfitSupport, [id]: now };
    } else if (v && !v.eased) track.outfitVeto = { ...track.outfitVeto, [id]: { at: now, eased: true } };
  }
  track.outfitAgrees = { at: now, ids: agrees };
}

/**
 * Whether a contradicting outfit currently rules `id` out on this track. A veto lapses with time only
 * once a readable sample over top and trousers has not contradicted it, `holdMs` after that sample: an
 * unreadable torso, a shirt-only view, a slow phone's sparse audits or a face-only stretch never let it
 * run out (a 2 s clock ran out between audits at 460 ms per frame). A new contradiction re-arms it.
 */
export function outfitVetoed(track: Track, id: string, now: number): boolean {
  const v = track.outfitVeto?.[id];
  if (!v || now < v.at) return false;
  return !v.eased || now - v.at <= OUTFIT_VETO.holdMs;
}

/**
 * Whether `id`'s own outfit corroborates a face on this track now (OUTFIT_RECENT_MS), and the body
 * overlaps nobody. While a partner may be hidden behind this body, the detector may have handed the
 * track their body this frame, so a corroboration read on an earlier frame counts only when this
 * frame's own outfit read still agrees with that player (crossing-lookalike-faces seed 716: Bob's
 * look-alike face, on a frame where only his face was found, read as Alice on her outfit read from
 * the frame before).
 */
export function outfitSupports(track: Pick<Track, 'outfitSupport' | 'overlapping' | 'ambiguous' | 'hiding' | 'outfitAgrees'>, id: string, now: number): boolean {
  if (track.overlapping || track.ambiguous) return false;
  const at = track.outfitSupport?.[id];
  if (at === undefined || now < at || now - at > OUTFIT_RECENT_MS) return false;
  return !track.hiding || (track.outfitAgrees?.at === now && track.outfitAgrees.ids.includes(id));
}

/** Best eligible player, for the live label. Null when the top belief is not a shootable player or their outfit is ruled out. */
export function bestBelief(track: Track, eligible: Set<string>, now = performance.now()): Resolution | null {
  const t = topBelief(track);
  return t && !track.identityConflict && eligible.has(t.id) && !outfitVetoed(track, t.id, now) ? t : null;
}

export { IDENTITY_TTL_MS };

/**
 * Whether a track has re-earned its identity since its last uncertain transition: enough fresh face
 * (or, for a back view, clothing) samples. Whether those faces may name a look-alike is decided where
 * they become evidence (faceEvidence's corroboration), not here.
 */
export function reacquired(track: Track): boolean {
  const at = track.reacquireAt ?? 0;
  if (!at) return true;
  const fresh = (track.faceSamples >= REACQUIRE.faceSamples && track.lastFaceSampleAt > at) || (track.clothingSince ?? 0) >= REACQUIRE.clothingSamples;
  return fresh;
}

/**
 * Why a body under the dot did not resolve to a hit, in the order the rules are checked. Every
 * refusal is explainable from its reason (review of 2026-10-01): the HUD advice, the shot log, the
 * shot sample, realcheck and the session report all carry it.
 */
export type Refusal =
  /** No identity evidence within IDENTITY_TTL_MS. */
  | 'no-evidence'
  /** Somebody may be hidden behind this body (Track.hiding): only this frame's own read can confirm it. */
  | 'hidden-partner'
  /** An overlap, an ambiguous face or another uncertain transition is waiting for agreeing evidence. */
  | 'unconfirmed'
  /** After an uncertain transition, not yet REACQUIRE fresh face or clothing samples. */
  | 'reacquiring'
  /** Two bodies claim the same player. */
  | 'conflict'
  /** The top belief is the shooter, a stranger or someone not in play. */
  | 'not-a-player'
  /** The top belief's scanned outfit is ruled out on this body (OUTFIT_VETO). */
  | 'vetoed'
  /** Below the hit confidence with no recent clear outfit match on this body, so any face was judged at FACE_ONLY_CALIB. */
  | 'no-outfit-backing'
  /** Below the hit confidence. */
  | 'low-confidence'
  /** Not clearly ahead of the runner-up. */
  | 'margin'
  /** An overlap or a frame at BODY_CAP without this body's own recent face read naming the player. */
  | 'no-fresh-read';

/**
 * The hit decision with its reason: `hit` is what resolveHit returns, `refusal` why it is null (null
 * when it is a hit). The checks and their order are resolveHit's.
 */
export function explainHit(track: Track, eligible: Set<string>, threshold: number, margin: number, now = performance.now()): { hit: Resolution | null; refusal: Refusal | null } {
  const no = (refusal: Refusal) => ({ hit: null, refusal });
  if (!Number.isFinite(track.lastEvidenceAt) || now < track.lastEvidenceAt || now - track.lastEvidenceAt > IDENTITY_TTL_MS) return no('no-evidence');
  // After a frame that could not tell whose face was whose, the identity waits for fresh evidence.
  if (track.unconfirmed) return no(track.hiding ? 'hidden-partner' : 'unconfirmed');
  if (!reacquired(track)) return no('reacquiring');
  const t = topBelief(track);
  if (!t) return no('no-evidence');
  if (track.identityConflict) return no('conflict');
  if (!eligible.has(t.id)) return no('not-a-player');
  if (outfitVetoed(track, t.id, now)) return no('vetoed');
  if (!Number.isFinite(t.score) || t.score < threshold) return no(outfitSupports(track, t.id, now) ? 'low-confidence' : 'no-outfit-backing');
  if (!Number.isFinite(t.margin) || t.margin < margin || t.margin <= 0) return no('margin');
  // During an overlap the belief may have been carried over from the other body: this body's own
  // latest face must name the same player clearly, on its own. The same holds in a frame at the
  // detector's body cap, where an undetected person may share this box or have handed it over.
  // The read's age is measured in capture time against the frame this body was last seen in, not
  // against `now`: on a slow phone the decision comes more than OVERLAP_FACE_FRESH_MS after the
  // capture, and a read from that very frame would otherwise always be too old (review of
  // 2026-10-01). How old the frame itself may be is the callers' rule (geometryFresh, freshFrame).
  if (track.overlapping || track.ambiguous || track.crowded) {
    const r = track.lastRead;
    if (!r || r.at > track.lastSeen || track.lastSeen - r.at > OVERLAP_FACE_FRESH_MS || r.id !== t.id || r.margin < margin) return no('no-fresh-read');
  }
  return { hit: t, refusal: null };
}

/** A hit only registers when the top candidate is a live opponent, confident, and clearly ahead of everyone else. */
export function resolveHit(track: Track, eligible: Set<string>, threshold: number, margin: number, now = performance.now()): Resolution | null {
  return explainHit(track, eligible, threshold, margin, now).hit;
}
