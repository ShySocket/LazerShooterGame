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
export const CALIBRATION_VERSION = '2026-09-14.4';

// ---- Face similarity (embedding.ts) -------------------------------------------------------------
/** Centred cosine below `reject` is no evidence for a player; above `accept` is a solid match. */
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

// ---- Evidence fusion (scoring.ts) ---------------------------------------------------------------
/** Relative weight of each signal when it is present. */
export const EVIDENCE_WEIGHTS = { face: 0.6, cloth: 0.3, body: 0.1 };
/** The stranger vote a partial outfit match must beat by the hit margin. */
export const STRANGER_BASELINE = 0.95;
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
/** Two bodies within this face-association score of each other make the face's owner ambiguous. */
export const ASSOCIATION_MARGIN = 0.18;

// ---- Aim (geometry.ts) --------------------------------------------------------------------------
/** A dot this close to another body's edge, as a fraction of that box, may really be on it. */
export const AIM_EDGE_BAND = { x: 0.05, y: 0.03 };

// ---- Shot timing (shot.ts) ----------------------------------------------------------------------
/** How old a finished frame may be, before the frame period widens it. */
export const STALE_FRAME_MS = 350;
export const MAX_STALE_FRAME_MS = 1100;
/** Geometry older than this cannot decide a shot on its own; it can only nominate a burst. */
export const GEOMETRY_FRESH_MS = 250;
/** A borderline shot may wait this long for more frames: at least two more frames on a slow phone. */
export const BURST_MS = 300;
export const MAX_BURST_MS = 900;
export const BURST_FRAMES = 12;

// ---- Pipeline scheduling and live enrolment (pipeline.ts) ---------------------------------------
/** Clothing is only re-sampled for tracks whose face has not been seen this recently. */
export const FACE_FRESH_MS = 1500;
/** Pixel readback for clothing happens at most this often, whatever the frame rate. */
export const CLOTHING_INTERVAL_MS = 150;
/** While the face carries the identity, the outfit is still checked this often for a contradiction. */
export const CLOTHING_AUDIT_MS = 1000;
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
