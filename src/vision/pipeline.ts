import { UNKNOWN_ID, type BodyProps, type OutfitSig } from '../types';
import { clothingDue, cropBudget } from './schedule';
import { CLOTHING_AUDIT_MS, CLOTHING_BELIEF_ALPHA, CLOTHING_CONTRADICTION, FACE_BELIEF_ALPHA, FACE_FRESH_MIN_MARGIN, FACE_FRESH_MS, FACE_REFRESH_MIN_LEAD, FACE_REFRESH_MS, FACE_VIA_TIMEOUT_MS, MATURE_TRACK_OBSERVATIONS, TORSO_COVER_FRACTION, LIVE_FACE_ENROLLED_MIN, LIVE_FACE_MIN, LIVE_FACE_MIN_BELIEF, LIVE_FACE_MIN_QUALITY, LIVE_FACE_MIN_TRACK_SAMPLES, LIVE_FACE_NOVELTY, LIVE_FACE_RUNNER_UP, LIVE_FACES_PER_PLAYER, HOP_READ_MARGIN } from './calibration';
import { containsPoint, faceOwner, markUncertain, resetIdentity, trackGapMs, Tracker, type Detection, type Track } from './tracker';
import { crosshairCentre, indexInSight, intersectArea, type NBox } from './geometry';
import {
  assignIdentities,
  bestBelief,
  bodyEvidence,
  clothingEvidence,
  combineEvidence,
  faceEvidence,
  IDENTITY_TTL_MS,
  outfitSupports,
  outfitVetoed,
  reacquired,
  resolveHit,
  topBelief,
  updateBelief,
  updateFaceMean,
  updateOutfitVeto,
  type Candidate,
  type Resolution,
} from './scoring';
import { centredSimilarity, FACE_CALIB } from './embedding';
import { BURST_FRAMES, burstAllowanceMs, canConfirmShot, FramePeriod, freshFrame, geometryFresh, snapshotTrack, staleAllowanceMs } from './shot';

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
  /** The player the track was believed to be at the tap, when it had one: the burst may confirm only them. */
  expectedId: string | null;
}

/** Besides the crosshair target, this many other bodies get a face crop per frame, round-robin. */
const EXTRA_CROPS = 1;
/** The live-enrolment log kept for the shot log and the bench; older entries roll off. */
const LEARNED_LOG_MAX = 200;

/** Whether a track other than `id` in the list still covers the point. */
const coveredByOther = (tracks: Track[], id: number, x: number, y: number): boolean => tracks.some((c) => c.id !== id && containsPoint(c.box, x, y));

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
  /** Face samples learned during this round, per player id. */
  private liveFaces = new Map<string, number[][]>();
  /** When and how well each live sample was learned, for the shot log and the bench. */
  private learned: { id: string; t: number; toEnrolled: number; quality: number }[] = [];
  private augmented: { source: Candidate[]; candidates: Candidate[] } | null = null;

  constructor(
    private config: PipelineConfig,
    private clock: () => number = () => performance.now(),
  ) {}

  configure(config: PipelineConfig): void {
    this.config = config;
  }

  /**
   * Forget frames, tracks, and pending shots: the camera, viewport, or round changed. A burst that
   * was still open can never settle now, so its context is handed back for the caller to report
   * (every tap owes the player a verdict, even "the shot was lost").
   */
  invalidate(): C | null {
    const dropped = this.pending?.context ?? null;
    this.epoch++;
    this.tracker.reset();
    this.period.reset();
    this.latest = null;
    this.pending = null;
    this.lastClothingAt = -Infinity;
    this.liveFaces.clear();
    this.learned = [];
    this.augmented = null;
    return dropped;
  }

  /** Every live-enrolment event this round: which player, when, how close to their enrolled scan. */
  liveFaceLog(): { id: string; t: number; toEnrolled: number; quality: number }[] {
    return this.learned.slice();
  }

  /** How many face samples have been learned live for each player this round. */
  liveFaceCounts(): Record<string, number> {
    return Object.fromEntries([...this.liveFaces].map(([id, list]) => [id, list.length]));
  }

  /** The configured candidates with this round's live face samples appended. */
  private galleries(): Candidate[] {
    const source = this.config.candidates;
    if (this.augmented && this.augmented.source === source) return this.augmented.candidates;
    const candidates = source.map((c) => {
      const live = this.liveFaces.get(c.id);
      return live?.length ? { id: c.id, profile: { ...c.profile, face: [...(c.profile.face ?? []), ...live] } } : c;
    });
    this.augmented = { source, candidates };
    return candidates;
  }

  private learnFace(id: string, emb: number[], ranked: [string, number][], quality: number, track: Track, now: number): void {
    if (id === UNKNOWN_ID || quality < LIVE_FACE_MIN_QUALITY) return;
    // Only a face the game would act on is learned: their own outfit backs it on this body, nothing
    // vetoes them, and the identity is settled. A look-alike's face learned into a player's gallery
    // would later match himself and clear any bar (review of 2026-10-01).
    if (!outfitSupports(track, id, now) || outfitVetoed(track, id, now) || track.unconfirmed || track.identityConflict || !reacquired(track)) return;
    const enrolled = this.config.candidates.find((c) => c.id === id);
    if (!enrolled) return;
    if (ranked[0][1] < LIVE_FACE_MIN || (ranked[1]?.[1] ?? 0) > LIVE_FACE_RUNNER_UP) return;
    const belief = topBelief(track);
    if (!belief || belief.id !== id || belief.score < LIVE_FACE_MIN_BELIEF || track.via !== 'face' || track.faceSamples < LIVE_FACE_MIN_TRACK_SAMPLES) return;
    let toEnrolled = 0;
    for (const s of enrolled.profile.face ?? []) toEnrolled = Math.max(toEnrolled, centredSimilarity(s, emb));
    if (toEnrolled < LIVE_FACE_ENROLLED_MIN) return;
    const list = this.liveFaces.get(id) ?? [];
    if (list.some((s) => centredSimilarity(s, emb) >= LIVE_FACE_NOVELTY)) return;
    list.push(emb.slice());
    if (list.length > LIVE_FACES_PER_PLAYER) list.shift();
    if (this.learned.length >= LEARNED_LOG_MAX) this.learned.shift();
    this.learned.push({ id, t: this.clock(), toEnrolled: Math.round(toEnrolled * 100) / 100, quality: Math.round(quality * 100) / 100 });
    this.liveFaces.set(id, list);
    this.augmented = null;
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
    const candidates = this.galleries();
    const current = topBelief(t);
    // A face names a player at the normal bar only when their own outfit backs it on this body; any
    // other face must clear the face-only bar (scoring.ts outfitSupports, OUTFIT_RECENT_MS).
    const corroborated = (id: string) => outfitSupports(t, id, now);
    const raw = faceEvidence(emb, candidates, centredSimilarity, FACE_CALIB, quality, corroborated);
    const ranked = Object.entries(raw).sort((a, b) => b[1] - a[1]);
    if (ranked[0]) t.lastRead = { at: now, id: ranked[0][0], margin: ranked[0][1] - (ranked[1]?.[1] ?? 0) };
    if (current && ranked[0] && ranked[0][0] !== current.id && ranked[0][1] >= 0.8 && (raw[current.id] ?? 0) < 0.2) resetIdentity(t);
    // This frame's face clearly names another player than the track believes: the track may have hopped
    // onto another body with no jump to notice (two people in one spot, a pan). Start the identity over.
    else if (current && current.id !== UNKNOWN_ID && ranked[0] && ranked[0][0] !== current.id && ranked[0][0] !== UNKNOWN_ID && ranked[0][1] - (ranked[1]?.[1] ?? 0) >= HOP_READ_MARGIN) markUncertain(t, now);
    if (ranked[0]) this.learnFace(ranked[0][0], emb, ranked, quality, t, now);
    const mean = updateFaceMean(t, emb, now);
    const fe = faceEvidence(mean, candidates, centredSimilarity, FACE_CALIB, quality, corroborated);
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
    // People the detector skipped this frame but who were here a moment ago: they still occupy their spot.
    const coasting = this.tracker.live().filter((t) => t.lastSeen !== now && now - t.lastSeen <= gapMs && !t.identityConflict).map(snapshotTrack);
    const sampleClothing = ops.sampleOutfit && clothingDue(this.period.ms(), this.lastClothingAt, now);
    if (sampleClothing) this.lastClothingAt = now;
    dets.forEach((d, i) => {
      const t = tracks[i];
      if (d.associationAmbiguous) return;
      if (now - t.lastEvidenceAt > IDENTITY_TTL_MS) resetIdentity(t);
      // Clothing and body ratios only matter while the face is not carrying the identity, except for
      // an occasional audit: a wardrobe that strongly contradicts the face is a reason to re-verify.
      const faceFresh = t.lastFaceAt > 0 && now - t.lastFaceAt < FACE_FRESH_MS && (topBelief(t)?.margin ?? 0) >= FACE_FRESH_MIN_MARGIN;
      const audit = faceFresh && now - t.lastClothingAt >= CLOTHING_AUDIT_MS;
      if (sampleClothing && d.body && (!faceFresh || audit)) {
        // Another person's box over this torso means the pixels may be theirs: abstain.
        const torso = t.hit;
        const covered = dets.some((o, j) => j !== i && intersectArea(o.box, torso) > TORSO_COVER_FRACTION * torso[2] * torso[3]);
        if (covered) return;
        const obs = ops.sampleOutfit!(d);
        if (!obs) return;
        // An unreadable torso is not a sample: the audit stays due and nothing counts as checked.
        if (!obs.sig) return;
        t.lastClothingAt = now;
        t.lastOutfitReadAt = now;
        // A sample read while this body overlaps someone may vet a name but never back one up.
        updateOutfitVeto(t, obs.sig, candidates, now, !t.overlapping && !t.ambiguous);
        // An unconfirmed identity may not be propped up by its own old belief: it has to earn it back.
        const ce = clothingEvidence(obs.sig, candidates, t.unconfirmed ? undefined : t.belief);
        const be = obs.props ? bodyEvidence(obs.props, candidates) : null;
        const ev = combineEvidence({ face: null, cloth: ce, body: be });
        if (!ev) return;
        if (audit) {
          const top = topBelief(t);
          const ranked = Object.entries(ev).sort((a, b) => b[1] - a[1]);
          const contradicts = top && ranked[0] && ranked[0][0] !== top.id && ranked[0][0] !== UNKNOWN_ID && ranked[0][1] >= CLOTHING_CONTRADICTION.top && (ev[top.id] ?? 0) <= CLOTHING_CONTRADICTION.current;
          // Suspend the identity until fresh evidence rebuilds it; do not swap to the outfit's answer.
          if (contradicts) resetIdentity(t);
          return;
        }
        updateBelief(t, ev, CLOTHING_BELIEF_ALPHA, now);
        t.clothingSince = (t.clothingSince ?? 0) + 1;
        if (t.via !== 'face' || now - t.lastFaceAt > FACE_VIA_TIMEOUT_MS) t.via = 'clothing';
      }
    });

    // Face embeddings come only from magnified square crops. The crosshair target gets one every
    // frame; the other bodies take turns so the frame rate stays predictable.
    // Hit regions come from the tracks: a track keeps the torso it observed a moment ago through a
    // frame in which only the face was found.
    const idx = indexInSight(
      dets.map((d) => d.box),
      crosshair,
      tracks.map((t) => t.hit),
    );
    // A person seen a moment ago whose box still covers the dot has not vanished: aiming there is ambiguous.
    const [dotX, dotY] = crosshairCentre(crosshair);
    const blocked = idx >= 0 && coveredByOther(coasting, tracks[idx].id, dotX, dotY);
    const inSight: Track | null = idx >= 0 && !blocked && !dets[idx].associationAmbiguous ? tracks[idx] : null;
    let zoomed = false;
    const order: number[] = [];
    // The crosshair target is cropped every frame only while its identity is not yet a hit: a pending
    // shot, an unconfirmed or conflicted identity, a young track, or a belief that does not resolve.
    // A confident target is refreshed on a bounded interval so a contradiction is still caught.
    if (idx >= 0) {
      const t = tracks[idx];
      const hit = resolveHit(t, eligible, hitThreshold, hitMargin, now);
      // A thin lead over the runner-up (look-alike faces, a shared shirt) is not confidence enough to
      // rest on: those targets keep their crop every frame.
      const confident = !this.pending && !t.unconfirmed && !t.identityConflict && t.observations >= MATURE_TRACK_OBSERVATIONS && hit !== null && hit.margin >= hitMargin + FACE_REFRESH_MIN_LEAD;
      if (!confident || now - t.lastFaceAt >= FACE_REFRESH_MS) order.push(idx);
    }
    // Everybody else takes turns, including bodies whose face the full-frame pass did not find (the
    // head crop is where a distant face turns up) and a lone person the shooter is not aiming at yet,
    // so an identity is ready by the time the dot reaches them.
    // A slow or throttled phone sheds the extra crops (schedule.ts): the target keeps its own.
    const extraCrops = cropBudget(this.period.ms(), EXTRA_CROPS);
    if (extraCrops > 0 && dets.length > (idx >= 0 ? 1 : 0)) {
      // Who needs a look most: a body with no face sample yet, then the one whose face is oldest;
      // ties rotate with the cursor so a plain round-robin is the fallback.
      const n = dets.length;
      const pool = dets.map((_, j) => j).filter((j) => j !== idx && (dets[j].face || dets[j].body));
      const key = (j: number): [number, number, number] => [tracks[j].faceSamples > 0 ? 1 : 0, tracks[j].lastFaceAt || 0, (j - this.cropCursor + n) % n];
      pool.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
      });
      for (const j of pool) if (order.length < 1 + extraCrops) order.push(j);
      this.cropCursor = (this.cropCursor + 1) % n;
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
    // Tracks that have gathered fresh evidence since their last uncertain transition are settled again.
    for (const t of tracks) if (t.reacquireAt && reacquired(t)) t.reacquireAt = 0;
    assignIdentities(tracks, exclusiveIds);
    this.latest = { dets, tracks: tracks.map(snapshotTrack), coasting, width, height, t: now };
    const decisionAt = this.clock();
    const stale = this.staleMs();

    // A borderline shot waits here for the next few frames of evidence.
    let settled: ShotSettlement<C> | null = null;
    const p = this.pending;
    if (p && now >= p.startedAt) {
      const t = inSight?.id === p.trackId ? inSight : null;
      const elapsed = Math.round(decisionAt - p.startedAt);
      let r = canConfirmShot(p, t, now, decisionAt, stale) && t ? resolveHit(t, eligible, hitThreshold, hitMargin, decisionAt) : null;
      // A burst that started on one accepted identity must not quietly land on another.
      if (r && p.expectedId && r.id !== p.expectedId) r = null;
      // Nor on a track that went through an uncertain transition after the tap: it may now be
      // somebody else's body (crossing-lookalike-faces seed 63: a 1.1 s burst settled on the partner).
      if (r && t && (t.reacquireAt ?? 0) > p.startedAt) r = null;
      p.framesLeft--;
      p.zoom ||= zoomed;
      // A frame in which the detector skipped the target is not the target leaving: the burst keeps
      // waiting while their track coasts within the gap and nobody else has stepped under the dot.
      // Only a different person's body under the dot ends the burst early. The target's own body in a
      // frame that cannot select them (ambiguous association, the dot off the observed torso, a
      // neighbour's edge within the band) is a reason to wait for the next frame, not a miss.
      const [cx, cy] = crosshairCentre(crosshair);
      const someoneElse = !t && dets.some((d, j) => tracks[j].id !== p.trackId && containsPoint(d.box, cx, cy));
      const targetCoasting = !t && !someoneElse && this.tracker.live().some((x) => x.id === p.trackId && now - x.lastSeen <= gapMs);
      if ((!t && !targetCoasting) || r || decisionAt >= p.deadline || p.framesLeft <= 0) {
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
        const b = bestBelief(inSight, eligible, decisionAt);
        const top = topBelief(inSight);
        if (b && b.score > 0.2) lock = { kind: 'maybe', id: b.id, score: b.score };
        // A name the outfit has ruled out is not shown even as a guess.
        else if (top && top.score > 0.3 && !outfitVetoed(inSight, top.id, decisionAt)) lock = { kind: 'top', id: top.id };
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
    if (!L || !usable) return { kind: 'no-camera' };
    // Only fresh geometry may decide a shot on its own. An older frame can still say who was under the
    // dot: the burst below then has to see that same track under the dot in a frame captured after
    // the tap before anything counts. A frame so old that even that is meaningless is refused.
    const staleStart = !geometryFresh(L.t, now);
    // The same bound the game's NO FRESH FRAMES watchdog uses, so a tap on a frozen camera is refused
    // rather than shown as LOCKING while the label says frames have stopped.
    if (!freshFrame(L.t, now, Math.max(1000, allowanceMs * 2))) return { kind: 'stale', frameAgeMs: Math.round(now - L.t), allowanceMs };
    const idx = indexInSight(
      L.dets.map((d) => d.box),
      crosshair,
      L.tracks.map((t) => t.hit),
    );
    const [cx, cy] = crosshairCentre(crosshair);
    let best = idx >= 0 && !L.dets[idx].associationAmbiguous ? L.tracks[idx] : null;
    // Somebody seen a moment ago still covering the dot makes the aim ambiguous, whoever is detected now.
    if (best && coveredByOther(L.coasting, best.id, cx, cy)) best = null;
    let coasted = false;
    const moved = (b: NBox, t: Track): NBox => {
      const age = now - t.lastSeen;
      // Velocity plus bounded acceleration, the same shift the tracker predicts with.
      const ax = Math.max(-b[2] * 0.5, Math.min(b[2] * 0.5, 0.5 * t.ax * age * age));
      const ay = Math.max(-b[3] * 0.5, Math.min(b[3] * 0.5, 0.5 * t.ay * age * age));
      return [b[0] + t.vx * age + ax, b[1] + t.vy * age + ay, b[2], b[3]];
    };
    const moving = (t: Track) => t.vx !== 0 || t.vy !== 0;
    if (!best && idx === -1) {
      // The pose model skipped the person under the dot for a frame. The burst below must see them
      // again in a fresh frame before anything counts, so this can only delay a verdict, never invent one.
      const under = L.coasting.filter((t) => containsPoint(t.hit, cx, cy));
      if (under.length === 1 && !L.dets.some((d) => containsPoint(d.box, cx, cy))) {
        best = under[0];
        coasted = true;
      }
    }
    if (!best && idx === -1 && !coasted) {
      // The frame is a period old and everybody has moved since (a pan, a walk): nobody is under the
      // dot in the old geometry, but the person whose motion carries them there now may be, whether
      // the detector found them in that frame or skipped them. They are only nominated: the burst
      // still has to see them under the dot in a frame captured after the tap, so this can turn a
      // premature miss into a wait, never into a hit from prediction.
      // The nomination keeps the tap-time rule: the dot has to be on the moved observed torso, not
      // merely inside the moved outer box. Nominating from the outer box was tried (2026-09-14): it
      // lifted the pan-crossing hit rate by nine points and produced a hit on a player nobody was
      // aiming at when the tap happened, which the burst then confirmed 332 ms later. Never again.
      const j = indexInSight(
        L.tracks.map((t, i) => moved(L.dets[i].box, t)),
        crosshair,
        L.tracks.map((t) => moved(t.hit, t)),
      );
      if (j >= 0 && !L.dets[j].associationAmbiguous && moving(L.tracks[j])) {
        best = L.tracks[j];
        coasted = true;
      } else if (j === -1) {
        const under = L.coasting.filter((c) => moving(c) && containsPoint(moved(c.hit, c), cx, cy));
        const anyDet = L.tracks.some((t, i) => containsPoint(moved(L.dets[i].box, t), cx, cy));
        if (under.length === 1 && !anyDet) {
          best = under[0];
          coasted = true;
        }
      }
    }
    if (!best) {
      // Nobody under the dot in a frame too old to trust is not a miss the player can learn from.
      if (!freshFrame(L.t, now, allowanceMs)) return { kind: 'stale', frameAgeMs: Math.round(now - L.t), allowanceMs };
      return { kind: 'miss' };
    }
    // Geometry younger than GEOMETRY_FRESH_MS may decide alone only if the motion seen since it was
    // captured still leaves the dot on the same person's torso: on a pan, everybody shifts in those
    // ~250 ms and the person under the dot then may no longer be (review of 2026-10-01: aiming at the
    // farther player of a pan crossing gave instant wrong hits). Otherwise the burst decides.
    const stillUnder = idx >= 0 && !coasted && indexInSight(L.tracks.map((t, i) => moved(L.dets[i].box, t)), crosshair, L.tracks.map((t) => moved(t.hit, t))) === idx;
    const r = coasted || staleStart || !stillUnder ? null : resolveHit(best, eligible, hitThreshold, hitMargin, now);
    if (r) return { kind: 'instant', settlement: { track: best, resolution: r, elapsedMs: 0, zoomed: false, context } };
    // A burst opened from an old frame is still waiting for the slow frame in flight, so it gets that
    // much longer before it gives up.
    const burstMs = this.burstMs() + (staleStart ? allowanceMs : 0);
    const believed = bestBelief(best, eligible, now);
    const shot: PendingShot<C> = { trackId: best.id, startedAt: now, deadline: now + burstMs, framesLeft: BURST_FRAMES, zoom: false, track: best, context, expectedId: believed && believed.score >= hitThreshold ? believed.id : null };
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
