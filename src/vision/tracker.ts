import type { BodyResult, FaceResult } from '@vladmandic/human';
import { ASSOCIATION_MARGIN, CONFIRMED_OBSERVATIONS, CROSSING_IOU, FACE_CUE, FACE_CUE_FRESH_MS, STATIONARY_HYPOTHESIS, TENTATIVE_WIN_MARGIN, HEIGHT_CONFIRM_MIN, HEIGHT_MATCH_MIN, LOST_TRACK_MS, MAX_TRACK_GAP_MS, TRACK_GAP_MS } from './calibration';
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
export function trackState(t: Track, now: number): TrackState {
  if (t.lastSeen < now) return 'lost';
  return t.observations >= CONFIRMED_OBSERVATIONS ? 'confirmed' : 'tentative';
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
  return 0.35 + 0.1 * Math.max(0, 1 - Math.abs(cx - x - w / 2) / (w / 2));
}

function faceCandidates(faceBox: NBox, dets: Detection[]): { index: number; score: number }[] {
  return dets.map((d, index) => ({ index, score: faceAssociationScore(faceBox, d) }))
    .filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
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

interface Motion {
  vx: number;
  vy: number;
  /** Fractional width and height growth per ms: an approaching player's box grows, a leaving one shrinks. */
  sw: number;
  sh: number;
  samples: number;
}

/**
 * A person the pose model skipped for a frame or two is still the same person. Longer gaps, or any
 * gap where somebody else could have stepped into the box, require fresh identity evidence.
 */

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
    this.match(dets, candidates, now, gapMs, assigned);
    const out = dets.map((d, i) => {
      let t = assigned.get(i);
      if (!t) {
        t = { id: this.nextId++, box: [...d.box], hit: [...(d.hit ?? d.box)], hitObservedAt: d.body ? now : 0, lastSeen: now, belief: {}, claimed: null, via: 'none', lastFaceAt: 0, lastClothingAt: 0, lastEvidenceAt: 0, faceMean: null, faceSamples: 0, lastFaceSampleAt: 0, unconfirmed: false, observations: 1, vx: 0, vy: 0 };
        this.tracks.push(t);
        this.motion.set(t.id, { vx: 0, vy: 0, sw: 0, sh: 0, samples: 1 });
      } else {
        // A box that shrank or grew by more than a quarter in one step is a suspicious match: the
        // identity is kept but must be confirmed by fresh evidence before it can lock or take a hit.
        if (heightRatio(d.box, t.box) < HEIGHT_CONFIRM_MIN) t.unconfirmed = true;
        const m = this.motion.get(t.id)!;
        const dt = now - t.lastSeen;
        // Reclaimed after more than the continuity gap: the body is where it was expected, but the
        // identity must be confirmed by fresh evidence before it can lock or take a hit.
        if (dt > gapMs) t.unconfirmed = true;
        const [oldX, oldY] = center(t.box);
        const [newX, newY] = center(d.box);
        const alpha = m.samples === 1 ? 1 : 0.7;
        m.vx = (1 - alpha) * m.vx + alpha * (newX - oldX) / dt;
        m.vy = (1 - alpha) * m.vy + alpha * (newY - oldY) / dt;
        m.sw = (1 - alpha) * m.sw + alpha * (d.box[2] / t.box[2] - 1) / dt;
        m.sh = (1 - alpha) * m.sh + alpha * (d.box[3] / t.box[3] - 1) / dt;
        m.samples++;
        t.observations++;
        const settled = m.samples <= 1 ? 0 : m.samples === 2 ? 0.6 : 1;
        t.vx = m.vx * settled;
        t.vy = m.vy * settled;
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
      if (d.associationAmbiguous) t.unconfirmed = true;
      return t;
    });
    // Crossing: bodies that overlap each other, or a body that has moved over where a briefly skipped
    // neighbour was, cannot lock or take a hit until fresh evidence confirms the identity on that
    // body. This is where a swapped identity would otherwise ride unnoticed.
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (iou(out[i].box, out[j].box) >= CROSSING_IOU) out[i].unconfirmed = out[j].unconfirmed = true;
      }
      for (const c of this.tracks) {
        if (c.lastSeen === now || now - c.lastSeen > gapMs) continue;
        if (iou(out[i].box, c.box) >= CROSSING_IOU) out[i].unconfirmed = true;
      }
    }
    this.lastUpdate = now;
    return out;
  }

  /** Mutual-best matching of detections against live and briefly skipped tracks. */
  private match(dets: Detection[], candidates: Track[], now: number, gapMs: number, assigned: Map<number, Track>): void {
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
      const trust = m.samples <= 1 ? 0 : m.samples === 2 ? 0.6 : 1;
      const dx = Math.max(-t.box[2], Math.min(t.box[2], m.vx * dt * trust));
      const dy = Math.max(-t.box[3], Math.min(t.box[3], m.vy * dt * trust));
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
          if (shape < 0.6 || overlap < 0.35 || distance > 0.4) return 0;
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
    const confirmed = candidates.map((t) => t.observations >= CONFIRMED_OBSERVATIONS);
    const uniqueBest = (values: number[]): number => {
      const order = values.map((score, index) => ({ score, index })).filter((p) => p.score >= 0.3).sort((a, b) => b.score - a.score);
      return order.length && (!order[1] || order[0].score - order[1].score >= 0.12) ? order[0].index : -1;
    };
    // Per detection: a skipped track only wins when no live track fits well, and then by a clear margin.
    // A stale duplicate sitting on top of a live track must not turn every frame into a tie that spawns
    // a new track, nor steal a detection the live track explains.
    const bestTrack = scores.map((row) => {
      const order = row.map((score, index) => ({ score, index })).filter((p) => p.score >= 0.3).sort((a, b) => b.score - a.score);
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
      if (live[best.index] || (liveRival && (liveRival.score >= 0.5 || best.score - liveRival.score < 0.12))) {
        return uniqueBest(row.map((s, i) => (live[i] && eligible(i) ? s : 0)));
      }
      return !pool[1] || best.score - pool[1].score >= 0.12 ? best.index : -1;
    });
    const bestDetection = candidates.map((_, ti) => uniqueBest(scores.map((row) => row[ti])));
    dets.forEach((_, i) => {
      const ti = bestTrack[i];
      if (ti >= 0 && bestDetection[ti] === i) assigned.set(i, candidates[ti]);
    });
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
