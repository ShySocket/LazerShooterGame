import type { BodyProps, OutfitSig } from '../types';
import { containsPoint, faceOwner, resetIdentity, trackGapMs, Tracker, type Detection, type Track } from './tracker';
import { indexInSight, type NBox } from './geometry';
import {
  assignIdentities,
  bestBelief,
  bodyEvidence,
  clothingEvidence,
  combineEvidence,
  faceEvidence,
  IDENTITY_TTL_MS,
  resolveHit,
  topBelief,
  updateBelief,
  updateFaceMean,
  type Candidate,
  type Resolution,
} from './scoring';
import { FACE_CALIB, unitSimilarity } from './embedding';
import { BURST_FRAMES, burstAllowanceMs, canConfirmShot, FramePeriod, freshFrame, snapshotTrack, staleAllowanceMs } from './shot';

/** A unit face embedding that already passed validity, confidence, yaw, and size checks. */
export interface FaceObservation {
  /** Face box in full-frame normalised coordinates. */
  box: NBox;
  embedding: number[];
  /** 0..1 from faceQuality(): how much a blurred, small face may be trusted. */
  quality: number;
}

export interface OutfitObservation {
  sig: OutfitSig | null;
  props: BodyProps | null;
}

/** What one camera frame can do for the pipeline. Implemented with Human in the game, synthetically in tests. */
export interface FrameOps {
  /** Clothing and proportions of one detected body, or null when this frame has no pixel readback. */
  sampleOutfit: ((det: Detection) => OutfitObservation | null) | null;
  /** Face pass on a magnified region of the frame. */
  cropFaces: (region: NBox, det: Detection) => Promise<FaceObservation[]>;
  /** False once the camera or screen this frame came from is gone. */
  isCurrent: () => boolean;
}

export interface PipelineConfig {
  candidates: Candidate[];
  /** Ids that at most one body may claim at a time (every enrolled candidate). */
  exclusiveIds: Set<string>;
  /** Live opponents: the only ids a hit may resolve to. */
  eligible: Set<string>;
  hitThreshold: number;
  hitMargin: number;
}

export interface Latest {
  dets: Detection[];
  tracks: Track[];
  /** Tracks the detector skipped this frame but which are still within the continuity gap. */
  coasting: Track[];
  width: number;
  height: number;
  t: number;
}

export type LockState =
  | { kind: 'lock'; id: string }
  | { kind: 'maybe'; id: string; score: number }
  | { kind: 'top'; id: string }
  | { kind: 'unknown' };

export interface ShotSettlement<C> {
  /** The body under the dot at decision time; null when it vanished or was replaced. */
  track: Track | null;
  resolution: Resolution | null;
  elapsedMs: number;
  zoomed: boolean;
  context: C;
}

export type FireResult<C> =
  | { kind: 'busy' }
  | { kind: 'no-camera' }
  | { kind: 'stale'; frameAgeMs: number; allowanceMs: number }
  | { kind: 'miss' }
  | { kind: 'instant'; settlement: ShotSettlement<C> }
  | { kind: 'pending'; token: object; deadline: number; burstMs: number };

export interface FrameOutcome<C> {
  dets: Detection[];
  tracks: Track[];
  inSight: Track | null;
  lock: LockState | null;
  /** A pending shot decided by this frame. */
  settled: ShotSettlement<C> | null;
  periodMs: number;
}

interface PendingShot<C> {
  trackId: number;
  startedAt: number;
  deadline: number;
  framesLeft: number;
  zoom: boolean;
  track: Track;
  context: C;
}

/** Clothing is only re-sampled for tracks whose face has not been seen this recently. */
const FACE_FRESH_MS = 1500;
/** Pixel readback for clothing happens at most this often, whatever the frame rate. */
export const CLOTHING_INTERVAL_MS = 250;
/** Besides the crosshair target, this many other bodies get a face crop per frame, round-robin. */
const EXTRA_CROPS = 1;
/** Belief step per face frame; two frames of a good match are enough for a lock. */
const FACE_BELIEF_ALPHA = 0.45;

/**
 * Everything between detector output and a shot verdict: tracking, evidence fusion, identity
 * assignment, the live lock label, and the fire/burst logic. No DOM, no React, injectable clock, so
 * a whole laser-tag round can be simulated in a test.
 */
export class VisionPipeline<C = unknown> {
  private tracker = new Tracker();
  private period = new FramePeriod();
  private latest: Latest | null = null;
  private pending: PendingShot<C> | null = null;
  private epoch = 0;
  private cropCursor = 0;
  private lastClothingAt = -Infinity;

  constructor(
    private config: PipelineConfig,
    private clock: () => number = () => performance.now(),
  ) {}

  configure(config: PipelineConfig): void {
    this.config = config;
  }

  /** Forget frames, tracks, and pending shots: the camera, viewport, or round changed. */
  invalidate(): void {
    this.epoch++;
    this.tracker.reset();
    this.period.reset();
    this.latest = null;
    this.pending = null;
    this.lastClothingAt = -Infinity;
  }

  getLatest(): Latest | null {
    return this.latest;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Measured time between finished frames; NaN until two frames have completed. */
  periodMs(): number {
    return this.period.ms();
  }

  staleMs(): number {
    return staleAllowanceMs(this.period.ms());
  }

  burstMs(): number {
    return burstAllowanceMs(this.period.ms());
  }

  /** Fold a face seen on a track into its running mean and belief. */
  private applyFace(t: Track, emb: number[], quality: number, now: number): void {
    const { candidates } = this.config;
    const current = topBelief(t);
    const raw = faceEvidence(emb, candidates, unitSimilarity, FACE_CALIB, quality);
    const ranked = Object.entries(raw).sort((a, b) => b[1] - a[1]);
    if (current && ranked[0] && ranked[0][0] !== current.id && ranked[0][1] >= 0.8 && (raw[current.id] ?? 0) < 0.2) resetIdentity(t);
    const mean = updateFaceMean(t, emb);
    const fe = faceEvidence(mean, candidates, unitSimilarity, FACE_CALIB, quality);
    const ev = combineEvidence({ face: fe, cloth: null, body: null });
    // The running mean already smooths frame noise, so the belief may follow it quickly.
    if (ev) updateBelief(t, ev, FACE_BELIEF_ALPHA, now);
    t.via = 'face';
    t.lastFaceAt = now;
  }

  /**
   * One detector result. Returns null when the frame was abandoned (camera changed, invalidated
   * mid-frame), in which case nothing was published.
   */
  async processFrame(dets: Detection[], capturedAt: number, width: number, height: number, crosshair: NBox, ops: FrameOps): Promise<FrameOutcome<C> | null> {
    const { candidates, exclusiveIds, eligible, hitThreshold, hitMargin } = this.config;
    const now = capturedAt;
    const generation = this.epoch;
    this.period.push(now);

    const gapMs = trackGapMs(this.period.ms());
    const tracks = this.tracker.update(dets, now, undefined, gapMs);
    const sampleClothing = ops.sampleOutfit && now - this.lastClothingAt >= CLOTHING_INTERVAL_MS;
    if (sampleClothing) this.lastClothingAt = now;
    dets.forEach((d, i) => {
      const t = tracks[i];
      if (d.associationAmbiguous) return;
      if (now - t.lastEvidenceAt > IDENTITY_TTL_MS) resetIdentity(t);
      // Clothing and body ratios only matter while the face is not carrying the identity.
      const faceFresh = t.lastFaceAt > 0 && now - t.lastFaceAt < FACE_FRESH_MS && (topBelief(t)?.margin ?? 0) >= 0.3;
      if (sampleClothing && d.body && !faceFresh) {
        const obs = ops.sampleOutfit!(d);
        if (!obs) return;
        const ce = obs.sig ? clothingEvidence(obs.sig, candidates) : null;
        const be = obs.props ? bodyEvidence(obs.props, candidates) : null;
        const ev = combineEvidence({ face: null, cloth: ce, body: be });
        if (ev) {
          updateBelief(t, ev, 0.35, now);
          if (t.via !== 'face' || now - t.lastFaceAt > 3000) t.via = 'clothing';
        }
      }
    });

    // Face embeddings come only from magnified square crops. The crosshair target gets one every
    // frame; the other bodies take turns so the frame rate stays predictable.
    const idx = indexInSight(
      dets.map((d) => d.box),
      crosshair,
    );
    const inSight: Track | null = idx >= 0 && !dets[idx].associationAmbiguous ? tracks[idx] : null;
    let zoomed = false;
    const order: number[] = [];
    if (idx >= 0) order.push(idx);
    if (dets.length > 1) {
      for (let k = 0; k < dets.length && order.length < 1 + EXTRA_CROPS; k++) {
        const j = (this.cropCursor + k) % dets.length;
        if (j !== idx && dets[j].face) order.push(j);
      }
      this.cropCursor = (this.cropCursor + 1) % dets.length;
    }
    const faced = new Set<number>();
    for (const j of order) {
      const d = dets[j];
      if (d.associationAmbiguous || !ops.isCurrent()) continue;
      const faces = await ops.cropFaces(d.box, d);
      if (!ops.isCurrent() || this.epoch !== generation) return null;
      if (j === idx) zoomed = true;
      const owned = new Map<number, FaceObservation[]>();
      for (const zf of faces) {
        const owner = faceOwner(zf.box, dets);
        if (owner >= 0 && !faced.has(owner)) owned.set(owner, [...(owned.get(owner) ?? []), zf]);
      }
      for (const [owner, matched] of owned) {
        if (matched.length !== 1) continue;
        this.applyFace(tracks[owner], matched[0].embedding, matched[0].quality, now);
        faced.add(owner);
      }
    }

    if (!ops.isCurrent() || this.epoch !== generation) return null;
    // Missing tracks cannot reserve an identity. Published beliefs stay fixed until a frame completes.
    assignIdentities(tracks, exclusiveIds);
    const coasting = this.tracker.live().filter((t) => t.lastSeen !== now && now - t.lastSeen <= gapMs && !t.identityConflict).map(snapshotTrack);
    this.latest = { dets, tracks: tracks.map(snapshotTrack), coasting, width, height, t: now };
    const decisionAt = this.clock();
    const stale = this.staleMs();

    // A borderline shot waits here for the next few frames of evidence.
    let settled: ShotSettlement<C> | null = null;
    const p = this.pending;
    if (p && now >= p.startedAt) {
      const t = inSight?.id === p.trackId ? inSight : null;
      const elapsed = Math.round(decisionAt - p.startedAt);
      const r = canConfirmShot(p, t, now, decisionAt, stale) && t ? resolveHit(t, eligible, hitThreshold, hitMargin, decisionAt) : null;
      p.framesLeft--;
      p.zoom ||= zoomed;
      if (!t || r || decisionAt >= p.deadline || p.framesLeft <= 0) {
        this.pending = null;
        // No track means the person under the dot changed or vanished: a miss, not an unclear read of them.
        settled = { track: t, resolution: r, elapsedMs: elapsed, zoomed: p.zoom, context: p.context };
      }
    }

    // Live lock indicator so the shooter knows what a shot would do.
    let lock: LockState | null = null;
    if (inSight && freshFrame(now, decisionAt, stale)) {
      const hit = resolveHit(inSight, eligible, hitThreshold, hitMargin, decisionAt);
      if (hit) lock = { kind: 'lock', id: hit.id };
      else {
        const b = bestBelief(inSight, eligible);
        const top = topBelief(inSight);
        if (b && b.score > 0.2) lock = { kind: 'maybe', id: b.id, score: b.score };
        else if (top && top.score > 0.3) lock = { kind: 'top', id: top.id };
        else lock = { kind: 'unknown' };
      }
    }
    return { dets, tracks, inSight, lock, settled, periodMs: this.period.ms() };
  }

  /**
   * FIRE was pressed. Decides instantly from the newest finished frame when it already carries a
   * verdict, otherwise opens a burst that the next frames (or expirePending) settle.
   * @param usable False when the screen is hidden or the video no longer matches the published frame.
   */
  fire(context: C, crosshair: NBox, usable = true): FireResult<C> {
    if (this.pending) return { kind: 'busy' };
    const now = this.clock();
    const { eligible, hitThreshold, hitMargin } = this.config;
    const L = this.latest;
    const allowanceMs = this.staleMs();
    if (!L || !usable || !freshFrame(L.t, now, allowanceMs)) {
      // A phone whose inference cannot keep up is not the same as having no usable camera at all.
      if (L && usable) return { kind: 'stale', frameAgeMs: Math.round(now - L.t), allowanceMs };
      return { kind: 'no-camera' };
    }
    const idx = indexInSight(
      L.dets.map((d) => d.box),
      crosshair,
    );
    let best = idx >= 0 && !L.dets[idx].associationAmbiguous ? L.tracks[idx] : null;
    let coasted = false;
    if (!best && idx === -1) {
      // The pose model skipped the person under the dot for a frame. The burst below must see them
      // again in a fresh frame before anything counts, so this can only delay a verdict, never invent one.
      const cx = crosshair[0] + crosshair[2] / 2;
      const cy = crosshair[1] + crosshair[3] / 2;
      const under = L.coasting.filter((t) => containsPoint(t.box, cx, cy));
      if (under.length === 1 && !L.dets.some((d) => containsPoint(d.box, cx, cy))) {
        best = under[0];
        coasted = true;
      }
    }
    if (!best) return { kind: 'miss' };
    const r = coasted ? null : resolveHit(best, eligible, hitThreshold, hitMargin, now);
    if (r) return { kind: 'instant', settlement: { track: best, resolution: r, elapsedMs: 0, zoomed: false, context } };
    const burstMs = this.burstMs();
    const shot: PendingShot<C> = { trackId: best.id, startedAt: now, deadline: now + burstMs, framesLeft: BURST_FRAMES, zoom: false, track: best, context };
    this.pending = shot;
    return { kind: 'pending', token: shot, deadline: shot.deadline, burstMs };
  }

  /** The burst timer ran out before a frame decided the shot. Null when that shot is no longer pending. */
  expirePending(token: object): ShotSettlement<C> | null {
    const p = this.pending;
    if (!p || p !== token) return null;
    this.pending = null;
    return { track: p.track, resolution: null, elapsedMs: Math.round(this.clock() - p.startedAt), zoomed: p.zoom, context: p.context };
  }
}
