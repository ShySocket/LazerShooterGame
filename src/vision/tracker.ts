import type { BodyResult, FaceResult } from '@vladmandic/human';
import { ACCEL_MAX_SHIFT, ACCEL_MIN_SAMPLES, ASSOCIATION_MARGIN, CENTRE_JUMP_CONFIRM, CONFIRMED_OBSERVATIONS, CROSSING_IOU, FACE_CUE, FACE_CUE_FRESH_MS, HIDDEN_PARTNER_MS, LIVE_RIVAL_MIN, LOST_RECLAIM, MATCH_MIN_SCORE, MATCH_WIN_MARGIN, STATIONARY_HYPOTHESIS, TENTATIVE_WIN_MARGIN, HEIGHT_CONFIRM_MIN, HEIGHT_MATCH_MIN, LOST_TRACK_MS, MAX_TRACK_GAP_MS, TRACK_GAP_MS } from './calibration';
import { clampBox, intersectArea, iou, toNBox, type NBox } from './geometry';

export interface Detection {
  box: NBox;
  body?: BodyResult;
  face?: FaceResult;
  /** More than one person could own this face/body; no identity evidence or shots are safe. */
  associationAmbiguous?: boolean;
  /**
   * The part of this person a shot may land on: the observed head and torso, never the empty corners
   * of the outer box or a body that was only inferred from a face. Missing means the whole box.
   */
  hit?: NBox;
}

export interface Track {
  id: number;
  box: NBox;
  /** Hittable region from the last observation; see Detection.hit. */
  hit: NBox;
  /** When `hit` last came from an observed body (pose landmarks), not a face alone. */
  hitObservedAt: number;
  lastSeen: number;
  /** Per-player identity belief in 0..1, updated by face and clothing evidence. */
  belief: Record<string, number>;
  /** Identity assignment view, refreshed every frame by assignIdentities. */
  claimed: Record<string, number> | null;
  identityConflict?: boolean;
  /**
   * The last observation could not say whose face was whose (ambiguous association). The identity is
   * kept, but it may not show a lock or take a hit until fresh evidence updates the belief again.
   */
  unconfirmed: boolean;
  /**
   * Players ruled out on this body by a contradicting outfit (scoring.ts updateOutfitVeto): when the
   * last contradiction was read, and whether a readable sample that did not contradict has been seen
   * since (only then may the veto lapse with time). Survives resetIdentity and uncertain transitions.
   */
  outfitVeto?: Record<string, { at: number; eased: boolean }>;
  /** When an outfit sample with a readable top was last taken on this body (unreadable samples do not count). */
  lastOutfitReadAt?: number;
  /**
   * Players whose own outfit corroborated a face on this body, with when: a readable sample over top
   * and trousers matched them at OUTFIT_BACK_MIN while the body overlapped nobody (scoring.ts
   * outfitSupports). Reset by every uncertain transition, so it never carries over to whoever the track
   * lands on next.
   */
  outfitSupport?: Record<string, number>;
  /**
   * Each player's outfit similarity summed over the readable samples (top and trousers) taken on this
   * body outside any overlap since its last uncertain transition: whose outfit the body wears, read
   * over time rather than from one sample (scoring.ts updateOutfitVeto, OUTFIT_RIVAL_LEAD); `fitSum`
   * and `fit` the same over the samples that did not contradict the player (OUTFIT_VETO.maxSim), how
   * much like their scan the outfit reads (OUTFIT_BACK_MIN). Reset with `outfitSupport`.
   */
  outfitReads?: Record<string, { sum: number; n: number; fitSum: number; fit: number }>;
  /** Players the last readable outfit sample on this track agreed with (OUTFIT_BACK_MIN over what it compared, top at least, and no rival ahead by OUTFIT_RIVAL_LEAD), and when. */
  outfitAgrees?: { at: number; ids: string[] };
  /**
   * When this track last went through an uncertain transition (crossing, reclaim after a gap, a jump,
   * an ambiguous face assignment): 0 when none is pending. Until fresh evidence is gathered after it
   * (scoring.ts reacquired) the track may not lock or take a hit.
   */
  reacquireAt?: number;
  /**
   * When this track last went through an uncertain transition, kept after the identity is re-earned
   * (`reacquireAt` is cleared then): a burst opened before it never lands on this track (pipeline.ts).
   */
  transitionAt?: number;
  /**
   * Clothing evidence samples taken since `reacquireAt` (back views re-earn the identity this way),
   * counting only samples at least CLOTHING_INTERVAL_MS apart: a hiding body's outfit is read on every
   * frame, and on a fast phone two reads 66 ms apart are one moment seen twice (pipeline.ts).
   */
  clothingSince?: number;
  /** When the last sample counted in `clothingSince` was taken; reset with it. */
  clothingCountedAt?: number;
  /** The last single-frame face read on this track: whom it named, by how much, and when (overlap rule). */
  lastRead?: { at: number; id: string; margin: number };
  /** Whether the previous frame had this track overlapping another or ambiguously associated (onset detection). */
  overlapping?: boolean;
  ambiguous?: boolean;
  /**
   * Tracks this body was last seen overlapping, with when (HIDDEN_PARTNER_MS): both seen, or this body
   * over the last box of a confirmed neighbour lost a moment ago. While such a partner is not detected they may
   * be hidden behind or in front of this body, and the detector may hand this track their body in any
   * frame; the entry ends once the partner is seen apart from it again.
   */
  partners?: Record<number, number>;
  /**
   * A partner (see `partners`) is not detected this frame: this frame's body may be theirs. The
   * identity then stands only on reads of this frame's body (pipeline.ts applyFace and the outfit
   * check, scoring.ts outfitSupports), never on a running face mean or an outfit read before it, and
   * a face only when it sits on this body's own head (faceOnOwnHead). The outfit read alone confirms
   * nothing: the partner may fill its pixels when they stand in front.
   */
  hiding?: boolean;
  /** Whether the frame this track was last seen in returned the detector's full BODY_CAP bodies (crowd rule). */
  crowded?: boolean;
  via: 'face' | 'clothing' | 'none';
  lastFaceAt: number;
  /** When clothing pixels were last sampled for this track (evidence or audit). */
  lastClothingAt: number;
  lastEvidenceAt: number;
  /** Running mean of the unit face embeddings seen on this track. */
  faceMean: number[] | null;
  /** Independent face samples folded into the mean: frames closer than the spacing count once. */
  faceSamples: number;
  /** When the last independent face sample was counted. */
  lastFaceSampleAt: number;
  /** How many frames this track has been matched to a detection; below CONFIRMED_OBSERVATIONS it is tentative. */
  observations: number;
  /** Trusted velocity of the box centre in frame units per ms (0 until the motion has settled). */
  vx: number;
  vy: number;
  /** Trusted acceleration of the box centre in frame units per ms², 0 until several samples exist. */
  ax: number;
  ay: number;
}

/**
 * Track states, derived rather than stored:
 *
 *   new detection ──▶ tentative (1 observation) ──▶ confirmed (2+) ──▶ lost (skipped, within LOST_TRACK_MS) ──▶ retired
 *                          │                              ▲                  │
 *                          └── outranked by any confirmed track for a body   └── reclaims its body under strict
 *                                                                               gates, comes back unconfirmed
 */
export type TrackState = 'tentative' | 'confirmed' | 'lost';
export const isConfirmed = (t: Track): boolean => t.observations >= CONFIRMED_OBSERVATIONS;
export function trackState(t: Track, now: number): TrackState {
  if (t.lastSeen < now) return 'lost';
  return isConfirmed(t) ? 'confirmed' : 'tentative';
}

const validBox = (b: number[]): boolean => b.length === 4 && b.every(Number.isFinite) && b[2] > 0 && b[3] > 0;
const center = (b: NBox): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];
/** Smaller over larger box height: 1 for equal heights. */
const heightRatio = (a: NBox, b: NBox): number => Math.min(a[3] / b[3], b[3] / a[3]);
export { HEIGHT_CONFIRM_MIN, HEIGHT_MATCH_MIN, MAX_TRACK_GAP_MS, TRACK_GAP_MS };

/** Confidence that a face belongs to a detection, using the actual head landmarks when present. */
function faceAssociationScore(faceBox: NBox, d: Detection): number {
  if (!validBox(faceBox) || !validBox(d.box)) return 0;
  const [cx, cy] = center(faceBox);
  if (d.face) {
    const expected = toNBox(d.face.boxRaw);
    const overlap = intersectArea(faceBox, expected) / Math.min(faceBox[2] * faceBox[3], expected[2] * expected[3]);
    const [ex, ey] = center(expected);
    const distance = Math.hypot((cx - ex) / Math.max(faceBox[2], expected[2]), (cy - ey) / Math.max(faceBox[3], expected[3]));
    if (overlap >= 0.45 && distance < 0.75) return 0.8 + 0.2 * iou(faceBox, expected);
    // A crop containing a different face must never overwrite this detection's face.
    return 0;
  }
  if (!d.body) return 0;
  const head = d.body.keypoints.filter((p) =>
    ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar', 'head'].includes(p.part)
    && p.score >= 0.4 && p.positionRaw.slice(0, 2).every(Number.isFinite));
  if (head.length) {
    const nose = head.find((p) => p.part === 'nose');
    const x = nose ? nose.positionRaw[0] : head.reduce((sum, p) => sum + p.positionRaw[0], 0) / head.length;
    const y = nose ? nose.positionRaw[1] : head.reduce((sum, p) => sum + p.positionRaw[1], 0) / head.length;
    const distance = Math.hypot((cx - x) / faceBox[2], (cy - y) / faceBox[3]);
    return distance < 0.9 ? 0.55 + 0.4 * (1 - distance / 0.9) : 0;
  }
  // Weak fallback for backs/partial poses. It can only win when ownership is unique.
  const [x, y, w, h] = d.box;
  if (cx < x - w * 0.1 || cx > x + w * 1.1 || cy < y - h * 0.1 || cy > y + h * 0.45) return 0;
  // With both shoulders observed, this body's head can only be above them and between them: a face
  // anywhere else in the box belongs to somebody standing behind or beside this person.
  const shoulders = d.body.keypoints.filter((p) => (p.part === 'leftShoulder' || p.part === 'rightShoulder') && p.score >= 0.4 && p.positionRaw.slice(0, 2).every(Number.isFinite));
  if (shoulders.length === 2) {
    const [a, b] = shoulders.map((p) => p.positionRaw);
    if (cy >= (a[1] + b[1]) / 2 || cx < Math.min(a[0], b[0]) || cx > Math.max(a[0], b[0])) return 0;
  }
  return 0.35 + 0.1 * Math.max(0, 1 - Math.abs(cx - x - w / 2) / (w / 2));
}

function faceCandidates(faceBox: NBox, dets: Detection[]): { index: number; score: number }[] {
  return dets.map((d, index) => ({ index, score: faceAssociationScore(faceBox, d) }))
    .filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
}

/**
 * Whether a face sits on this detection's own head: its box contains the body's nose, or the middle
 * of its other head landmarks when the nose is missing. A body without head landmarks cannot show
 * that any face is its own; a face-only detection is its face. faceOwner accepts a face up to most of
 * a face width off the nose, which is right while nobody else can be there; while somebody may be
 * hidden at this body (Track.hiding) a face beside its head may be theirs (the face of the person in
 * front, read on the sliver of the person behind them).
 */
export function faceOnOwnHead(faceBox: NBox, d: Detection): boolean {
  if (!d.body) return true;
  if (!validBox(faceBox)) return false;
  const head = d.body.keypoints.filter((p) => HEAD_PARTS.includes(p.part) && p.score >= 0.4 && p.positionRaw.slice(0, 2).every(Number.isFinite));
  if (!head.length) return false;
  const nose = head.find((p) => p.part === 'nose');
  const x = nose ? nose.positionRaw[0] : head.reduce((s, p) => s + p.positionRaw[0], 0) / head.length;
  const y = nose ? nose.positionRaw[1] : head.reduce((s, p) => s + p.positionRaw[1], 0) / head.length;
  return containsPoint(faceBox, x, y);
}

/** Unique owner of a full-frame or zoom face; -1 means missing or ambiguous ownership. */
export function faceOwner(faceBox: NBox, dets: Detection[]): number {
  const candidates = faceCandidates(faceBox, dets);
  const best = candidates[0];
  if (!best || dets[best.index].associationAmbiguous) return -1;
  if (candidates[1] && best.score - candidates[1].score < ASSOCIATION_MARGIN) return -1;
  return best.index;
}

/**
 * Where a standing person's body is, given only their face. Shaped like the pose model's box so a
 * body the pose model skips for a frame keeps its track instead of turning into a new person.
 */
export function faceBodyBox(face: NBox): NBox {
  const [x, y, w, h] = face;
  return clampBox([x + w / 2 - w * 1.5, y - h * 0.35, w * 3, h * 7.6]);
}

const HEAD_PARTS = ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar'];

/**
 * Where a shot may land on a person: the box around the observed shoulders and hips (the torso) plus
 * the head, padded a little for box jitter. A body without reliable torso landmarks falls back to
 * the middle of its box; a face with no body offers only the head. Arms, legs and the empty corners
 * of the outer box never take a hit.
 */
export function hitRegion(box: NBox, body?: BodyResult, face?: FaceResult): NBox {
  const pts = (parts: string[], min: number) => (body?.keypoints ?? [])
    .filter((p) => parts.includes(p.part) && p.score >= min && p.positionRaw.slice(0, 2).every(Number.isFinite))
    .map((p) => [p.positionRaw[0], p.positionRaw[1]] as [number, number]);
  const torso = pts(['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'], 0.4);
  const head = pts(HEAD_PARTS, 0.4);
  if (torso.length >= 3) {
    const xs = torso.map((p) => p[0]);
    const ys = torso.map((p) => p[1]);
    let x1 = Math.min(...xs);
    let x2 = Math.max(...xs);
    let y1 = Math.min(...ys);
    let y2 = Math.max(...ys);
    const shoulderW = Math.max(x2 - x1, box[2] * 0.3);
    if (face && validBox(face.boxRaw)) {
      const f = toNBox(face.boxRaw);
      x1 = Math.min(x1, f[0]);
      x2 = Math.max(x2, f[0] + f[2]);
      y1 = Math.min(y1, f[1]);
    } else if (head.length) {
      const hw = shoulderW * 0.35;
      for (const p of head) {
        x1 = Math.min(x1, p[0] - hw / 2);
        x2 = Math.max(x2, p[0] + hw / 2);
        y1 = Math.min(y1, p[1] - hw * 0.8);
      }
    }
    const px = shoulderW * 0.12;
    const py = (y2 - y1) * 0.06;
    return clampBox([x1 - px, y1 - py, x2 - x1 + 2 * px, y2 - y1 + 2 * py]);
  }
  if (!body && face && validBox(face.boxRaw)) {
    const f = toNBox(face.boxRaw);
    return clampBox([f[0] - f[2] * 0.2, f[1] - f[3] * 0.15, f[2] * 1.4, f[3] * 1.3]);
  }
  // Pose without a usable torso: the middle of the box, where a standing person's trunk is.
  const [x, y, w, h] = box;
  return clampBox([x + w * 0.2, y, w * 0.6, h * 0.75]);
}

/** Assemble people without attaching the first face found inside an overlapping body box. */
export function buildDetections(bodies: BodyResult[], faces: FaceResult[]): Detection[] {
  const dets: Detection[] = bodies.filter((b) => validBox(b.boxRaw) && b.score >= 0.25)
    .map((body) => ({ box: clampBox(toNBox(body.boxRaw)), body }))
    .filter((d) => validBox(d.box));
  const usableFaces = faces.filter((f) => validBox(f.boxRaw) && f.boxScore >= 0.5)
    .sort((a, b) => b.boxScore - a.boxScore)
    .filter((face, index, all) => !all.slice(0, index).some((other) => iou(toNBox(face.boxRaw), toNBox(other.boxRaw)) > 0.65));
  // Score against the original bodies: adding one face must not bias subsequent assignments.
  const owners = usableFaces.map((face) => faceCandidates(toNBox(face.boxRaw), dets));
  const claims = new Map<number, FaceResult[]>();
  usableFaces.forEach((face, i) => {
    const matches = owners[i];
    const best = matches[0];
    if (!best) return;
    if (matches[1] && best.score - matches[1].score < ASSOCIATION_MARGIN) {
      for (const match of matches) if (best.score - match.score < ASSOCIATION_MARGIN) dets[match.index].associationAmbiguous = true;
      return;
    }
    claims.set(best.index, [...(claims.get(best.index) ?? []), face]);
  });
  for (const [index, claimedFaces] of claims) {
    if (claimedFaces.length !== 1) dets[index].associationAmbiguous = true;
    else if (!dets[index].associationAmbiguous) dets[index].face = claimedFaces[0];
  }
  usableFaces.forEach((face, i) => {
    // Ambiguous faces must not also become duplicate, independently shootable bodies.
    if (owners[i].length) return;
    if (validBox(faceBodyBox(toNBox(face.boxRaw)))) dets.push({ box: faceBodyBox(toNBox(face.boxRaw)), face });
  });
  for (const d of dets) d.hit = hitRegion(d.box, d.body, d.face);
  return dets;
}

/** Discard all accumulated identity evidence when continuity is no longer trustworthy. */
/**
 * An uncertain transition: the face seen on this body may now be someone else's. The running face
 * mean starts over, the next clothing sample is due at once, and nothing locks or hits until fresh
 * evidence has been gathered (scoring.ts reacquired). The belief is kept, so a correct identity is
 * re-earned quickly. Outfit vetoes are kept too: they only ever refuse, and the next readable outfit
 * sample re-evaluates them (clearing them on a transition handed the name back to a ruled-out
 * look-alike after two face frames; review of 2026-10-01).
 */
export function markUncertain(track: Track, now: number): void {
  track.unconfirmed = true;
  track.faceMean = null;
  track.faceSamples = 0;
  track.lastFaceSampleAt = 0;
  track.lastClothingAt = 0;
  track.lastOutfitReadAt = 0;
  track.outfitSupport = undefined;
  track.outfitReads = undefined;
  track.reacquireAt = now;
  track.transitionAt = now;
  track.clothingSince = 0;
  track.clothingCountedAt = undefined;
}

export function resetIdentity(track: Track): void {
  track.belief = {};
  track.claimed = null;
  track.identityConflict = false;
  track.unconfirmed = false;
  track.via = 'none';
  track.lastFaceAt = 0;
  track.lastEvidenceAt = 0;
  track.faceMean = null;
  track.faceSamples = 0;
  track.lastFaceSampleAt = 0;
}

/** How far a velocity estimate is trusted: not at all from one observation, fully once it has settled. */
const motionTrust = (m: Motion): number => (m.samples <= 1 ? 0 : m.samples === 2 ? 0.6 : 1);

interface Motion {
  vx: number;
  vy: number;
  /** Change of velocity per ms, smoothed: a pan that slows or turns shows up here a frame early. */
  ax: number;
  ay: number;
  /** Fractional width and height growth per ms: an approaching player's box grows, a leaving one shrinks. */
  sw: number;
  sh: number;
  samples: number;
}

/** Acceleration is trusted only once several velocity samples exist, and then in full. */
const accelTrust = (m: Motion): number => (m.samples >= ACCEL_MIN_SAMPLES ? 1 : 0);
/** Where a box centre is expected `dt` ms after its last observation, from velocity and bounded acceleration. */
function predictShift(m: Motion, dt: number, size: [number, number]): [number, number] {
  const trust = motionTrust(m);
  const at = accelTrust(m);
  const ax = Math.max(-size[0] * ACCEL_MAX_SHIFT, Math.min(size[0] * ACCEL_MAX_SHIFT, 0.5 * m.ax * dt * dt * at));
  const ay = Math.max(-size[1] * ACCEL_MAX_SHIFT, Math.min(size[1] * ACCEL_MAX_SHIFT, 0.5 * m.ay * dt * dt * at));
  return [
    Math.max(-size[0], Math.min(size[0], m.vx * dt * trust + ax)),
    Math.max(-size[1], Math.min(size[1], m.vy * dt * trust + ay)),
  ];
}

/** Two skipped frames on this device, whatever its frame rate, within fixed bounds. */
export function trackGapMs(periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return TRACK_GAP_MS;
  return Math.max(TRACK_GAP_MS, Math.min(MAX_TRACK_GAP_MS, Math.round(periodMs * 3.2)));
}

/** Where a track is expected now, from its last box and motion; used for coasting through a dropout. */
export function containsPoint(box: NBox, x: number, y: number): boolean {
  return box[2] > 0 && box[3] > 0 && x >= box[0] && x <= box[0] + box[2] && y >= box[1] && y <= box[1] + box[3];
}

/** Spatial continuity is accepted only while visible and clearly matched in both directions. */
export class Tracker {
  private tracks: Track[] = [];
  private motion = new Map<number, Motion>();
  private nextId = 1;
  private lastUpdate: number | null = null;

  update(dets: Detection[], now: number, ttlMs = LOST_TRACK_MS, gapMs = TRACK_GAP_MS): Track[] {
    if (this.lastUpdate !== null && now <= this.lastUpdate) this.reset();
    // Expire before matching: an old person at the same position must not be revived.
    this.tracks = this.tracks.filter((t) => now - t.lastSeen < ttlMs);
    const liveIds = new Set(this.tracks.map((t) => t.id));
    for (const id of this.motion.keys()) if (!liveIds.has(id)) this.motion.delete(id);
    // People seen in the previous frame have priority, but a track the detector skipped for a frame
    // may still claim a detection it fits clearly better: when only one of two neighbours is found,
    // the live neighbour must not swallow the other person's body and carry its identity onto them.
    // Elapsed time gates every candidate, including one seen in the previous update: a long pause
    // with no frames at all (a stalled camera, a hidden tab) is a continuity break like any other.
    const assigned = new Map<number, Track>();
    // Every track within its time-to-live is a candidate; beyond the gap the gates are strict and the
    // identity comes back unconfirmed.
    const candidates = this.tracks;
    const contested = this.match(dets, candidates, now, gapMs, assigned);
    const out = dets.map((d, i) => {
      let t = assigned.get(i);
      if (!t) {
        t = { id: this.nextId++, box: [...d.box], hit: [...(d.hit ?? d.box)], hitObservedAt: d.body ? now : 0, lastSeen: now, belief: {}, claimed: null, via: 'none', lastFaceAt: 0, lastClothingAt: 0, lastEvidenceAt: 0, faceMean: null, faceSamples: 0, lastFaceSampleAt: 0, unconfirmed: false, observations: 1, vx: 0, vy: 0, ax: 0, ay: 0 };
        this.tracks.push(t);
        this.motion.set(t.id, { vx: 0, vy: 0, ax: 0, ay: 0, sw: 0, sh: 0, samples: 1 });
      } else {
        // A box that shrank or grew by more than a quarter in one step, or whose centre jumped more
        // than half a box width, is a suspicious match: the identity is kept but must be confirmed by
        // fresh evidence before it can lock or take a hit.
        if (heightRatio(d.box, t.box) < HEIGHT_CONFIRM_MIN) markUncertain(t, now);
        if (Math.abs(center(d.box)[0] - center(t.box)[0]) > CENTRE_JUMP_CONFIRM * Math.max(d.box[2], t.box[2])) markUncertain(t, now);
        const m = this.motion.get(t.id)!;
        const dt = now - t.lastSeen;
        // Reclaimed after more than the continuity gap: the body is where it was expected, but the
        // identity must be confirmed by fresh evidence before it can lock or take a hit.
        if (dt > gapMs) markUncertain(t, now);
        // Another track not seen this frame explains this body about as well: it may be theirs.
        if (contested.has(t)) markUncertain(t, now);
        const [oldX, oldY] = center(t.box);
        const [newX, newY] = center(d.box);
        const alpha = m.samples === 1 ? 1 : 0.7;
        const vx = (1 - alpha) * m.vx + alpha * (newX - oldX) / dt;
        const vy = (1 - alpha) * m.vy + alpha * (newY - oldY) / dt;
        // Acceleration from the change of the smoothed velocity, itself smoothed; meaningless before
        // the second velocity sample.
        if (m.samples >= 2) {
          m.ax = 0.5 * m.ax + 0.5 * (vx - m.vx) / dt;
          m.ay = 0.5 * m.ay + 0.5 * (vy - m.vy) / dt;
        }
        m.vx = vx;
        m.vy = vy;
        m.sw = (1 - alpha) * m.sw + alpha * (d.box[2] / t.box[2] - 1) / dt;
        m.sh = (1 - alpha) * m.sh + alpha * (d.box[3] / t.box[3] - 1) / dt;
        m.samples++;
        t.observations++;
        t.vx = m.vx * motionTrust(m);
        t.vy = m.vy * motionTrust(m);
        t.ax = m.ax * accelTrust(m);
        t.ay = m.ay * accelTrust(m);
      }
      // A frame in which only the face was found keeps the torso observed a moment ago, moved with the
      // box, so one dropped pose does not turn a chest shot into a head-only target. Never longer than
      // the continuity gap, and never for a person whose body was never observed.
      if (!d.body && t.hitObservedAt > 0 && now - t.hitObservedAt <= gapMs) {
        const [oldX, oldY] = center(t.box);
        const [newX, newY] = center(d.box);
        t.hit = clampBox([t.hit[0] + (newX - oldX), t.hit[1] + (newY - oldY), t.hit[2], t.hit[3]]);
      } else {
        t.hit = [...(d.hit ?? d.box)];
        if (d.body) t.hitObservedAt = now;
      }
      t.box = [...d.box];
      t.lastSeen = now;
      // A persistent condition (an ambiguous association, an overlap) starts over only at its onset;
      // while it lasts the track stays unconfirmed, as before, so fresh evidence can re-earn it rather
      // than being reset away every frame (a player half behind someone was unhittable for good).
      if (d.associationAmbiguous) {
        if (!t.ambiguous) markUncertain(t, now);
        else t.unconfirmed = true;
      }
      t.ambiguous = Boolean(d.associationAmbiguous);
      return t;
    });
    // Crossing: bodies that overlap each other, or a body that has moved over where a briefly skipped
    // neighbour was, cannot lock or take a hit until fresh evidence confirms the identity on that
    // body. This is where a swapped identity would otherwise ride unnoticed.
    const overlap = new Set<Track>();
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (iou(out[i].box, out[j].box) >= CROSSING_IOU) {
          overlap.add(out[i]);
          overlap.add(out[j]);
          out[i].partners = { ...out[i].partners, [out[j].id]: now };
          out[j].partners = { ...out[j].partners, [out[i].id]: now };
        }
      }
      // A neighbour lost here a moment ago (within the lost-track window, not just the coasting gap)
      // may be standing right behind: the detector alternates between two people in one spot, and the
      // surviving track then hops between them with no jump to notice (crossing-lookalike-faces seed 4).
      // The neighbour becomes a partner (below), so the presumption outlives their lost track: a person
      // can vanish behind another before their two boxes ever reach CROSSING_IOU, and stay there after
      // the lost track retires (crossing-lookalike-faces seed 716: Bob, last seen at IoU 0.23 beside
      // Alice, was forgotten 1.5 s later while still behind her; a frame then gave her track his body).
      // Only a confirmed neighbour becomes a partner this way: a track seen once is too often a
      // duplicate or a ghost (the contested rule's reason below), and on real group photos the
      // one-frame tracks of a flickering bystander kept restarting the clock (review of 2026-10-01:
      // 232 of 261 track-frames of one still photo presumed somebody hidden behind the body). The
      // lost track's box still flags the overlap above while it lives.
      for (const c of this.tracks) {
        if (c.lastSeen === now || now - c.lastSeen > ttlMs) continue;
        if (iou(out[i].box, c.box) >= CROSSING_IOU) {
          overlap.add(out[i]);
          if (!isConfirmed(c)) continue;
          out[i].partners = { ...out[i].partners, [c.id]: now };
          c.partners = { ...c.partners, [out[i].id]: now };
        }
      }
    }
    // A partner who stopped being detected while overlapping this body is hidden behind or in front
    // of it, not gone: in any frame the detector may find only them and hand this track their body,
    // with no jump or size change to notice. The check above compares stale boxes, which a camera pan
    // carries away from where both people now are, and forgets the partner once their track retires
    // (pan-crossing-far seed 85, 2026-10-01: Bob was last seen overlapping Alice's track 2.4 s
    // earlier; in a frame that found only his body her track took it, and with no evidence read on
    // that frame it showed LOCK alice with the dot on him). So the partner is remembered by track,
    // and until they are seen apart from this body (or HIDDEN_PARTNER_MS after the two were last
    // seen overlapping) the identity stands only on evidence read on each frame's own body.
    const seen = new Map(out.map((t) => [t.id, t]));
    const hiding = new Set<Track>();
    for (const t of out) {
      if (!t.partners) continue;
      const kept = Object.entries(t.partners).filter(([id, at]) => {
        const p = seen.get(Number(id));
        // Seen this frame: overlapping refreshed the entry above; apart, they are not hidden here.
        if (p) return iou(p.box, t.box) >= CROSSING_IOU;
        if (now - at > HIDDEN_PARTNER_MS) return false;
        hiding.add(t);
        return true;
      });
      t.partners = kept.length ? Object.fromEntries(kept) : undefined;
    }
    for (const t of out) {
      if (overlap.has(t)) {
        if (!t.overlapping) markUncertain(t, now);
        else t.unconfirmed = true;
      } else if (hiding.has(t)) {
        // Not a new transition (the overlap that started it already was one): the identity is kept,
        // and this frame's own face read on this body's head confirms it (scoring.ts updateBelief).
        t.unconfirmed = true;
      }
      t.overlapping = overlap.has(t);
      t.hiding = hiding.has(t);
    }
    this.lastUpdate = now;
    return out;
  }

  /** Mutual-best matching of detections against live and briefly skipped tracks; returns the tracks whose match is contested. */
  private match(dets: Detection[], candidates: Track[], now: number, gapMs: number, assigned: Map<number, Track>): Set<Track> {
    const live = candidates.map((t) => t.lastSeen === this.lastUpdate);
    const scores = dets.map((d) => candidates.map((t, ti) => {
      const gapped = !live[ti];
      // An ambiguous face-to-body association says nothing about which body this is: the box still
      // continues its track spatially. The flag keeps the frame from adding evidence, showing a lock
      // or taking a shot (pipeline.ts); breaking continuity here would throw away the identity of a
      // person who merely stood next to somebody for a frame.
      if (!validBox(d.box)) return 0;
      const shape = Math.min(d.box[2] / t.box[2], t.box[2] / d.box[2], d.box[3] / t.box[3], t.box[3] / d.box[3]);
      if (shape < (gapped ? 0.55 : 0.4)) return 0;
      // A standing person's height changes little between frames, while their width swings with the
      // arms. A box under 60% of the track's height is a different, farther person standing where
      // this one was (or a crouch, which costs a re-acquisition, never a wrong hit): when the near
      // player's detection drops for a frame, their track must not claim the far player's body and
      // carry a confident identity onto it.
      if (heightRatio(d.box, t.box) < HEIGHT_MATCH_MIN) return 0;
      const m = this.motion.get(t.id)!;
      // Predict to the actual observation time. A velocity measured from a single step is trusted
      // less than a settled one, and the prediction never carries a box further than its own size:
      // beyond that the uncertainty has swallowed the estimate.
      const dt = now - t.lastSeen;
      const lost = dt > gapMs;
      const trust = motionTrust(m);
      const [dx, dy] = predictShift(m, dt, [t.box[2], t.box[3]]);
      // The box also grows or shrinks along its recent trend, within a third either way.
      const pw = t.box[2] * Math.max(0.75, Math.min(1.33, 1 + m.sw * dt * trust));
      const ph = t.box[3] * Math.max(0.75, Math.min(1.33, 1 + m.sh * dt * trust));
      const predicted: NBox = [t.box[0] + dx + (t.box[2] - pw) / 2, t.box[1] + dy + (t.box[3] - ph) / 2, pw, ph];
      // Position uncertainty grows with the time since the last observation: the gates loosen a
      // little for a longer wait, but a person must still reappear where they were expected. Beyond
      // the continuity gap the track is lost and only a clear fit in the expected place reclaims it.
      const slack = Math.min(0.25, 0.25 * dt / gapMs);
      const fit = (expected: NBox): number => {
        const overlap = iou(d.box, expected);
        const [cx, cy] = center(d.box);
        const [px, py] = center(expected);
        const distance = Math.hypot((cx - px) / Math.max(d.box[2], t.box[2]), (cy - py) / Math.max(d.box[3], t.box[3]));
        if (lost) {
          if (shape < LOST_RECLAIM.shape || overlap < LOST_RECLAIM.overlap || distance > LOST_RECLAIM.distance) return 0;
        } else if (overlap < Math.max(0.05, (gapped ? 0.3 : 0.1) - slack) || distance > (gapped ? 0.5 : 0.8) + slack) return 0;
        return overlap * 0.75 + Math.max(0, 1 - distance) * 0.25;
      };
      // A person who stopped or turned around is where they were, not where the velocity says: the
      // stationary hypothesis competes with the prediction at a small discount, so a reversal, a pan
      // that changes direction, or a hand that stops does not cost the track.
      return Math.max(fit(predicted), trust > 0 ? STATIONARY_HYPOTHESIS * fit(t.box) : 0);
    }));
    // Face presence as a tiebreaker: a track identified by its face a moment ago belongs with the
    // body that still shows a face when another candidate body shows none. Relative, so a single
    // candidate is never penalised for a dropped face detection.
    candidates.forEach((t, ti) => {
      if (!(t.lastFaceAt > 0 && now - t.lastFaceAt <= FACE_CUE_FRESH_MS)) return;
      const fitting = dets.map((d, i) => ({ d, i })).filter(({ i }) => scores[i][ti] > 0);
      const faced = fitting.filter(({ d }) => d.face);
      if (faced.length === 0 || faced.length === fitting.length) return;
      for (const { d, i } of fitting) scores[i][ti] = Math.max(0, scores[i][ti] + (d.face ? FACE_CUE : -FACE_CUE));
    });
    const confirmed = candidates.map(isConfirmed);
    const uniqueBest = (values: number[]): number => {
      const order = values.map((score, index) => ({ score, index })).filter((p) => p.score >= MATCH_MIN_SCORE).sort((a, b) => b.score - a.score);
      return order.length && (!order[1] || order[0].score - order[1].score >= MATCH_WIN_MARGIN) ? order[0].index : -1;
    };
    // Per detection: a skipped track only wins when no live track fits well, and then by a clear margin.
    // A stale duplicate sitting on top of a live track must not turn every frame into a tie that spawns
    // a new track, nor steal a detection the live track explains.
    const bestTrack = scores.map((row) => {
      const order = row.map((score, index) => ({ score, index })).filter((p) => p.score >= MATCH_MIN_SCORE).sort((a, b) => b.score - a.score);
      if (!order.length) return -1;
      // A confirmed track (seen twice or more) explains a body better than one born last frame beside
      // it: a tentative track competes for a body only when it fits clearly better than the best
      // confirmed candidate, so a neighbour's fresh track cannot turn a good match into a tie that
      // costs an established identity, while a body that is plainly the newcomer's stays theirs.
      const bestConfirmed = order.find((p) => confirmed[p.index]);
      const eligible = (i: number) => confirmed[i] || !bestConfirmed || row[i] >= bestConfirmed.score + TENTATIVE_WIN_MARGIN;
      const pool = order.filter((p) => eligible(p.index));
      const best = pool[0];
      const liveRival = pool.find((p) => live[p.index]);
      // Live tracks compete only with each other; skipped ones are considered only when no live track fits.
      if (live[best.index] || (liveRival && (liveRival.score >= LIVE_RIVAL_MIN || best.score - liveRival.score < MATCH_WIN_MARGIN))) {
        return uniqueBest(row.map((s, i) => (live[i] && eligible(i) ? s : 0)));
      }
      return !pool[1] || best.score - pool[1].score >= MATCH_WIN_MARGIN ? best.index : -1;
    });
    const bestDetection = candidates.map((_, ti) => uniqueBest(scores.map((row) => row[ti])));
    dets.forEach((_, i) => {
      const ti = bestTrack[i];
      if (ti >= 0 && bestDetection[ti] === i) assigned.set(i, candidates[ti]);
    });
    // Live tracks win a body over skipped ones, but that is a tie-break, not evidence: when a track
    // left unmatched this frame fits the body about as well as the one that took it (no clear
    // MATCH_WIN_MARGIN win), geometry cannot tell whose body it is, and the identity on it must be
    // re-earned (pan-crossing seed 909 geometry: Alice was skipped for a frame during a pan, her body
    // then landed where Bob's live track expected him if he stood still, and LOCK bob showed on her).
    // Only confirmed tracks count: a track seen once is too often a duplicate or a ghost.
    const taken = new Set(assigned.values());
    const contested = new Set<Track>();
    for (const [i, t] of assigned) {
      const ti = candidates.indexOf(t);
      for (let ci = 0; ci < candidates.length; ci++) {
        const c = candidates[ci];
        if (c === t || taken.has(c) || !confirmed[ci]) continue;
        if (scores[i][ci] >= MATCH_MIN_SCORE && scores[i][ci] > scores[i][ti] - MATCH_WIN_MARGIN) contested.add(t);
      }
    }
    return contested;
  }

  /** Every track still within its time-to-live, including ones not matched this frame. */
  live(): Track[] {
    return this.tracks;
  }

  get(id: number): Track | undefined {
    return this.tracks.find((t) => t.id === id);
  }

  reset(): void {
    this.tracks = [];
    this.motion.clear();
    this.lastUpdate = null;
  }
}
