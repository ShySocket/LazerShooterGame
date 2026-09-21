/**
 * Every tunable the shooting decision depends on, in one place, with a version. The modules that
 * use them re-export the same names, so call sites and tests are unchanged; this file exists so a
 * shot log, a bench run or a sweep can say which calibration produced it, and so a change to one
 * number is visible next to the others it trades off against.
 *
 * Bump CALIBRATION_VERSION whenever any value below changes. Stored face scans stay raw normalised
 * embeddings, so a recalibration never needs a rescan.
 *
 *   camera frame ──▶ detect ──▶ track (gaps, height gates) ──▶ evidence (face, clothing, body)
 *                                                                │
 *                     FIRE ──▶ fresh geometry? ──▶ resolve (threshold, margin, TTL) ──▶ burst
 */
export const CALIBRATION_VERSION = '2026-09-21.1';

// ---- Face similarity (embedding.ts) -------------------------------------------------------------
/**
 * Thresholds on the mean-centred cosine (embedding.ts centredSimilarity). Measured on 2026-09-13 over
 * 61 faces through the game's crop pipeline: strangers median -0.03, 90th percentile 0.20, 99th 0.39;
 * a face against a downscaled copy of itself 0.92 at 28 px and 0.99 at 60 px. Raw cosine on this
 * model is unusable as an absolute score (strangers median 0.4, up to 0.8) because every embedding
 * shares one dominant direction. `reject` sits above the stranger 90th percentile, `accept` well
 * above the 99th.
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
/** Faces turned further than this from the camera are skipped. */
export const MAX_YAW_DEG = 45;

// ---- Enrolment scan (scan.ts, Scanner.tsx) -------------------------------------------------------
/**
 * The eight-angle face scan. Bands are absolute yaw in degrees, wide on purpose: the mesh-derived
 * angle underestimates a real turn and a player cannot hold a 17-degree band. Left and right only
 * have to be opposite signs (the mirrored preview and the model's sign convention cancel), latched
 * on the first turned sample; the same for chin up and down. A sample counts as the same person when
 * it is at least `samePerson` similar (centred cosine) to ANY accepted sample, so a turned head
 * chains through the adjacent angle rather than being compared to the frontal frame alone.
 * Enrolment keeps samples up to `enrolYawMax`; matching in a round still uses MAX_YAW_DEG.
 */
export const SCAN_CALIB = {
  straightYaw: [0, 15] as [number, number],
  slightYaw: [12, 40] as [number, number],
  furtherYaw: [25, 60] as [number, number],
  tiltPitch: [8, 40] as [number, number],
  holdFrames: 2,
  samePerson: SAME_PERSON_MIN,
  minFacePx: 48,
  /** Detector and crop scores below this mean poor light or a clipped face, not motion. */
  minFaceScore: 0.7,
  /** A magnified crop must overlap the detected face box this much (IoU) to be the same face. */
  minCropOverlap: 0.25,
  enrolYawMax: 60,
  /** Pause after an accepted sample before the next one may be taken. */
  settleMs: 400,
  /** The face stage detects on a copy no wider than this; a selfie-distance face is still hundreds of pixels. */
  faceDetectWidth: 960,
  /** How long the front body stage waits for far face samples once the outfit is complete. */
  farFacePatienceMs: 6000,
  minFarFaces: 6,
  /** A body box overlapping the last sampled one less than this is a step: the frame is skipped, the samples kept. */
  bodyMinOverlap: 0.25,
  /** Longer than this without a usable body and the outfit samples start over. */
  bodyGapMs: 1500,
  /** Sampling starts this long after the first usable body frame, so a player still walking back is not sampled mid-stride. */
  bodySettleMs: 800,
  /** After this long of "step back", the hint offers the small-room alternative. */
  smallRoomHintMs: 5000,
};

// ---- Loading and connecting (useHumanStatus.ts, App.tsx) ------------------------------------------
/** A model download that makes no progress for this long is reported as stalled, with a Retry. */
export const LOAD_CALIB = {
  modelStallMs: 45000,
  /** How often the loading text is refreshed from Human's model stats. */
  progressPollMs: 500,
  /** After this long on "Connecting" the player gets a Back button. */
  connectPatienceMs: 10000,
};

// ---- Evidence fusion (scoring.ts) ---------------------------------------------------------------
/** Relative weight of each signal when it is present. */
export const EVIDENCE_WEIGHTS = { face: 0.6, cloth: 0.3, body: 0.1 };
/** The stranger vote a partial outfit match must beat by the hit margin. */
export const STRANGER_BASELINE = 0.95;
/**
 * Outfit similarity to evidence: (sim - floor) / span, scaled by how much of the outfit was compared.
 * Without the trousers the scale is capped at noThighsCap, so a shirt alone cannot reach a hit.
 */
export const CLOTHING_EVIDENCE = { floor: 0.45, span: 0.35, noThighsCap: 0.55, coverageFloor: 0.2 };
/** A clothing region that clearly contradicts (clothing.ts REGION_CONTRADICTION) caps the whole outfit match here. */
export const REGION_CONTRADICTION_CAP = 0.4;
/** How fast the running face mean follows new frames once it has a few samples. */
export const MEAN_ALPHA = 0.3;
/** A new frame this dissimilar (centred) to the mean means the track switched person; start over. */
export const MEAN_RESET_SIM = 0.15;
/** Evidence older than this cannot resolve a shot. */
export const IDENTITY_TTL_MS = 1500;
/**
 * Belief smoothing is elapsed-time based: an `alpha` given to updateBelief is the step for one
 * frame of this period, and a frame `dt` later steps by 1 - (1 - alpha) ^ (dt / period). Two frames
 * 200 ms apart therefore move the belief exactly as far as one frame 400 ms later, and a fast phone
 * showing near-duplicate frames does not count each one as independent proof.
 */
export const BELIEF_REF_PERIOD_MS = 220;
/** A single frame after a long silence never jumps further than this many reference periods. */
export const BELIEF_MAX_STEPS = 2.5;
/** Face frames closer together than this count as one sample for the live-enrolment gates. */
export const LIVE_FACE_SAMPLE_SPACING_MS = 150;

// ---- Tracking (tracker.ts) ----------------------------------------------------------------------
/** A person skipped by the detector for this long is still the same person. */
export const TRACK_GAP_MS = 450;
export const MAX_TRACK_GAP_MS = 1100;
/**
 * A track the detector has not seen for longer than the gap is lost, not gone: it may reclaim a body
 * that reappears where it was expected, under stricter gates, for this long, and it comes back
 * unconfirmed (no lock or hit until fresh evidence). Beyond this it is retired.
 */
export const LOST_TRACK_MS = 1500;
/** A track seen fewer times than this is tentative: it never outranks a confirmed track for a body. */
export const CONFIRMED_OBSERVATIONS = 2;
/** A tentative track takes a body from a confirmed candidate only when its match score beats it by this much. */
export const TENTATIVE_WIN_MARGIN = 0.25;
/** A detection-to-track match below this score is no match; the winner must lead the runner-up by the margin. */
export const MATCH_MIN_SCORE = 0.3;
export const MATCH_WIN_MARGIN = 0.12;
/** A live track fitting a body at least this well keeps a skipped track from claiming it. */
export const LIVE_RIVAL_MIN = 0.5;
/** Gates for a lost track (skipped longer than the gap) to reclaim a body: shape ratio, IoU, centre distance. */
export const LOST_RECLAIM = { shape: 0.6, overlap: 0.35, distance: 0.4 };
/**
 * Weight of the 'stayed where they were' hypothesis against the velocity prediction when matching:
 * high enough to keep a track through a reversal, low enough that two players swapping places still
 * follow their predicted paths rather than each other's last box.
 */
export const STATIONARY_HYPOTHESIS = 0.75;
/**
 * The one appearance cue the full-frame pass gives before any crop: whether a body has a face box.
 * When a track whose identity came from its face this recently must choose between a body that
 * shows a face and one that does not, the faced body gains this much and the faceless one loses it.
 * Only applied when both kinds are on offer, so a dropped face never weakens a lone match.
 */
export const FACE_CUE = 0.15;
export const FACE_CUE_FRESH_MS = 1000;
/**
 * Two tracked bodies overlapping this much (IoU) are crossing: neither identity may lock or take a
 * hit until fresh evidence confirms it on its own body again. A body emerging from behind another
 * is where a swapped identity would otherwise go unnoticed until its face or outfit is checked.
 */
export const CROSSING_IOU = 0.25;
/** Below this height ratio a detection cannot continue a track at all. */
export const HEIGHT_MATCH_MIN = 0.6;
/** Below this ratio the match is kept but the identity waits for fresh evidence. */
export const HEIGHT_CONFIRM_MIN = 0.75;
/**
 * Acceleration enters the prediction only after this many observations, and never shifts a box by
 * more than this fraction of its size on top of the velocity term: a pan that turns around is
 * anticipated, box jitter is not amplified into a guess.
 */
export const ACCEL_MIN_SAMPLES = 4;
export const ACCEL_MAX_SHIFT = 0.5;
/** A box centre that jumped more than this fraction of the box width in one step keeps its identity only until fresh evidence confirms it. */
export const CENTRE_JUMP_CONFIRM = 0.5;
/** Two bodies within this face-association score of each other make the face's owner ambiguous. */
export const ASSOCIATION_MARGIN = 0.18;

// ---- Aim (geometry.ts) --------------------------------------------------------------------------
/** A dot this close to another body's edge, as a fraction of that box, may really be on it. */
export const AIM_EDGE_BAND = { x: 0.05, y: 0.03 };

// ---- Shot timing (shot.ts) ----------------------------------------------------------------------
/**
 * How old a finished frame may be before a tap on it is refused. Age is measured from capture,
 * including all inference time: on a phone the newest finished frame is between one and two
 * inference periods old at any tap, so shot.ts widens this with the measured period, up to the ceiling.
 */
export const STALE_FRAME_MS = 350;
export const MAX_STALE_FRAME_MS = 1100;
/**
 * Geometry budget for an instant hit: a position older than this cannot say who is under the dot
 * now, however well the person is known. Older frames only nominate a candidate for a burst that
 * must see them under the dot again in a frame captured after the tap. Unlike the stale allowance
 * this does not grow with a slow phone's frame period: slow inference widens the identity memory,
 * not the aim.
 */
export const GEOMETRY_FRESH_MS = 250;
/** A borderline shot may wait this long for more frames: at least two more frames on a slow phone. */
export const BURST_MS = 300;
export const MAX_BURST_MS = 900;
export const BURST_FRAMES = 12;

// ---- Pipeline scheduling and live enrolment (pipeline.ts) ---------------------------------------
/** Clothing is only re-sampled for tracks whose face has not been seen this recently and leads by this margin. */
export const FACE_FRESH_MS = 1500;
export const FACE_FRESH_MIN_MARGIN = 0.3;
/** Another body covering this share of a torso makes its clothing pixels unusable. */
export const TORSO_COVER_FRACTION = 0.3;
/** A clothing audit contradicts the face identity when the outfit's top pick reaches `top` while the current identity has at most `current`. */
export const CLOTHING_CONTRADICTION = { top: 0.75, current: 0.2 };
/** Belief step per clothing frame (one reference period). */
export const CLOTHING_BELIEF_ALPHA = 0.35;
/** A track whose face has not been seen for this long is carried by its clothing. */
export const FACE_VIA_TIMEOUT_MS = 3000;
/** A crosshair target with fewer observations than this is cropped every frame. */
export const MATURE_TRACK_OBSERVATIONS = 3;
/** Pixel readback for clothing happens at most this often, whatever the frame rate. */
export const CLOTHING_INTERVAL_MS = 150;
/** While the face carries the identity, the outfit is still checked this often for a contradiction. */
export const CLOTHING_AUDIT_MS = 1000;
/**
 * A crosshair target whose identity already resolves to a hit is re-cropped only this often; a face
 * crop costs about a third of a frame on a laptop and more on a phone, and a confident identity
 * needs a bounded refresh for contradiction detection, not a crop every frame. Anything less than
 * confident (pending shot, unconfirmed, conflict, young track, no resolvable hit) is cropped every frame.
 */
export const FACE_REFRESH_MS = 600;
/** A confident target whose lead over the runner-up is thinner than this (beyond the hit margin) is still cropped every frame: look-alikes need the frames. */
export const FACE_REFRESH_MIN_LEAD = 0.2;
/** Belief step per face frame; two frames of a good match are enough for a lock. */
export const FACE_BELIEF_ALPHA = 0.45;
/** Live enrolment gates: see pipeline.ts learnFace. */
export const LIVE_FACE_MIN = 0.9;
export const LIVE_FACE_RUNNER_UP = 0.3;
export const LIVE_FACE_MIN_QUALITY = 0.8;
export const LIVE_FACES_PER_PLAYER = 6;
export const LIVE_FACE_ENROLLED_MIN = 0.43;
export const LIVE_FACE_MIN_BELIEF = 0.85;
export const LIVE_FACE_MIN_TRACK_SAMPLES = 3;
export const LIVE_FACE_NOVELTY = 0.85;
