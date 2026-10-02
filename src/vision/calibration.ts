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
export const CALIBRATION_VERSION = '2026-10-01.11';

// ---- Face similarity (embedding.ts) -------------------------------------------------------------
/**
 * Thresholds on the mean-centred cosine (embedding.ts centredSimilarity) of InsightFace GhostNet
 * (strides 1), measured with npm run realcheck on 2026-09-26: 28 people's photos (different people
 * p90 0.17, p99 0.36) and interview clips scanned from their first 6 s (same person, same session:
 * single frame p5 0.49, median 0.67; the track's running mean p5 0.57, p10 0.60; the other person in
 * the same room p99 0.43; unenrolled faces p99 0.53). `reject` sits above the different-person 90th
 * percentile, `accept` at the same-person running mean's 10th percentile. Faces of different people
 * can still reach 0.69, which is why a contradicting outfit vetoes a face (OUTFIT_VETO).
 */
export const FACE_CALIB = { reject: 0.3, accept: 0.62 };
/**
 * Face thresholds for a candidate enrolled without any outfit (a practice target captured without
 * the hips in view): the outfit veto cannot rule a look-alike stranger out for them, so the face
 * alone must clear a stricter bar. On the sim's lookalike-stranger-faceonly scenario (a stranger at
 * about 0.66, the real different-person tail; 100 seeds): FACE_CALIB gave 35 wrong hits in 30 seeds,
 * 0.55/0.85 gave 4, 0.55/0.90 gives 0 while a face-only duel at 3 m still lands 27% (97% with an
 * outfit). Face alone cannot tell a look-alike apart, so practice capture asks for the hips in view.
 */
export const FACE_ONLY_CALIB = { reject: 0.6, accept: 0.95 };
/**
 * Two players whose scans are this alike will be confused at range; the lobby warns. GhostNet: the
 * closest pair of samples between two different people's scans measured 0.42 at most (6 people,
 * npm run realcheck clips, 2026-10-01).
 */
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
 * on the first turned sample; the same for chin up and down. The person scanned is the one face in
 * frame (several faces give no sample); face similarity is not used during the scan, because with
 * GhostNet the same person can score below other people at other angles (realcheck scan, 2026-10-01).
 * Enrolment keeps samples only up to `enrolYawMax`, the same MAX_YAW_DEG a round matches with.
 */
export const SCAN_CALIB = {
  straightYaw: [0, 15] as [number, number],
  slightYaw: [12, 40] as [number, number],
  furtherYaw: [25, 60] as [number, number],
  tiltPitch: [8, 40] as [number, number],
  holdFrames: 2,
  minFacePx: 48,
  /** Detector and crop scores below this mean poor light or a clipped face, not motion. */
  minFaceScore: 0.7,
  /** A magnified crop must overlap the detected face box this much (IoU) to be the same face. */
  minCropOverlap: 0.25,
  /** Templates beyond what a round ever matches (MAX_YAW_DEG) would only add chances for a look-alike to match. */
  enrolYawMax: MAX_YAW_DEG,
  /**
   * No prompt may dead-end. After `promptPatienceMs` on one prompt the best frame seen counts if it
   * went at least `patienceFraction` of the way to the band in the right direction (phones read a
   * real turn as less than it is); after `promptSkipMs` the player may skip the angle.
   */
  promptPatienceMs: 6000,
  patienceFraction: 0.5,
  promptSkipMs: 10000,
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

// ---- Network (Game.tsx, firebase.ts) ---------------------------------------------------------------
export const NET_CALIB = {
  /** A hit the server has not confirmed within this is reported as lost; the phone is offline or the link is dead. */
  hitTimeoutMs: 4000,
  /** Each phone stamps players/{id}/seenAt this often while the app is visible. */
  heartbeatMs: 20000,
  /** A player whose heartbeat is older than this counts as gone, whatever Firebase's own presence says. */
  presenceStaleMs: 60000,
};

// ---- Camera (useCamera.ts) --------------------------------------------------------------------------
export const CAM_CALIB = {
  /** How long a camera request may take when no permission prompt is expected. */
  requestTimeoutMs: 20000,
  /** How long to wait while the browser's permission sheet is open: a player reading it carefully takes a while. */
  promptTimeoutMs: 60000,
};

// ---- Scheduling under load (schedule.ts, useVisionLoop.ts) --------------------------------------
export const SCHED_CALIB = {
  /** Above this frame period the pipeline sheds work: no extra crops, clothing every other frame. The shot rules do not change. */
  slowPeriodMs: 250,
  /** Consecutive failed frames before the vision loop reloads the models and tells the player. */
  loopFailuresBeforeReset: 10,
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
/**
 * A person last seen overlapping a track who then stops being detected is presumed hidden behind (or
 * in front of) that body, not gone: in any frame the detector may find only them and hand the track
 * their body. Until they are seen apart from it again, or this long after the two were last seen
 * overlapping, the track needs evidence read on each frame's own body to lock or hit (tracker.ts
 * Track.partners, Track.hiding). Measured on the sim (2026-10-01): a partner stayed hidden 2.4 s before
 * the detector handed the track their body (pan-crossing-far seed 85); the hit-rate cost on the
 * crossing scenarios is the same from 2.5 s to 6 s. Since 2026-10-01.9 the clock also runs from a
 * track's box overlapping the last box of a confirmed neighbour lost a moment ago (crossing-lookalike-
 * faces seed 716: Bob vanished beside Alice before their boxes reached CROSSING_IOU; that rule first
 * shipped as 2026-10-01.7, a number main's capture-time read age (8cf05bb) already carried, so a
 * recording marked .7 may come from either build). Since 2026-10-01.9 (no value changed) a face read
 * counts on such a frame only on the body's own head (tracker.ts faceOnOwnHead), an outfit read alone
 * confirms nothing there (its pixels may be the partner's), and a burst on such a body ends when a frame
 * after the tap shows the dot off its torso (the sliver scenarios, tests/sim/engine.ts). Two unshipped
 * branches both used .8.
 */
export const HIDDEN_PARTNER_MS = 4000;
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
/**
 * Outfit veto (scoring.ts updateOutfitVeto). Real faces of different people reach 0.66 to 0.75 centred
 * similarity (npm run realcheck, 2026-09-26), above FACE_CALIB.accept, so a face alone can name a
 * look-alike stranger. Players play in the outfit they scanned: a sample covering at least the top
 * (`minCoverage`) whose match to a player's outfit is at most `maxSim` (a contradicting garment caps
 * the match at REGION_CONTRADICTION_CAP) rules that player out on this body for `holdMs`, whatever
 * the face says. A later sample matching at `clearSim` or better over at least `clearCoverage` of the
 * outfit lifts it at once (a matching shirt alone cannot lift a veto the trousers caused); a readable
 * sample in between lets it lapse `holdMs` after that sample; without readable samples it never
 * lapses (scoring.ts outfitVetoed). holdMs measured on the sim (2026-10-01): it must outlast the
 * clothing audit spacing on every phone (1 s gave 1653 wrong hits on lookalike-stranger; 2 s ran out
 * between audits at 460 ms per frame, 42 wrong hits on the slow-phone look-alike).
 */
export const OUTFIT_VETO = { maxSim: 0.4, minCoverage: 0.45, holdMs: 4000, clearSim: 0.6, clearCoverage: 0.7 };
/**
 * After an uncertain transition (tracker.ts markUncertain: a crossing, a reclaim, a jump, an
 * ambiguous face) a track re-earns its identity from fresh evidence only: this many independent face
 * samples taken after it, or clothing samples for a back view (review of 2026-10-01: one agreeing
 * frame of an old running mean was enough). Whether those faces may name a look-alike is the
 * corroboration rule below.
 */
export const REACQUIRE = { faceSamples: 2, clothingSamples: 2 };
/**
 * A face names a player at the normal bar (FACE_CALIB) only while their own outfit corroborates it: a
 * readable sample covering at least `OUTFIT_VETO.clearCoverage` (top and trousers) matched them at
 * OUTFIT_BACK_MIN or better on this body this recently, since its last uncertain transition, and not
 * while it overlaps someone, and it was their outfit rather than one like it (OUTFIT_BACK_MIN,
 * OUTFIT_RIVAL_LEAD). Otherwise (torso hidden, legs out of view, an overlap, a different outfit, a
 * similar one) the face must clear FACE_ONLY_CALIB, the bar a candidate enrolled without an outfit gets.
 */
export const OUTFIT_RECENT_MS = 3000;
/**
 * A sample backs a player's face (and agrees with them, for a hiding body's frame) only when no other
 * player's scanned outfit matches it better by more than this, nor this body's samples on average since
 * its last uncertain transition (Track.outfitReads); a sample that a rival explains that much better
 * takes back what earlier samples gave. Two reads of the same clothes differ by about this much (0.86
 * to 0.97 from 2 to 8 m, clothing.ts REGION_CONTRADICTION), so a rival ahead by more is wearing it.
 * Players in similar dark suits match each other's scans at 0.61 to 0.69 and their own at 0.91 to 0.95
 * (realcheck antony-blinken/08, 2026-10-02), above clearSim either way: before this rule every suit
 * backed every suited face, so poor crops of one player (0.38 to 0.55 like another's scan, 0.16 to
 * 0.40 like his own) were judged at the normal bar for the other, who was locked and hit on the first
 * player's body. Judged on each sample alone, one sample within the noise of two near-identical suits
 * still backed the other player for OUTFIT_RECENT_MS (sim dark-suits, 1000-seed sweep).
 */
export const OUTFIT_RIVAL_LEAD = 0.1;
/**
 * How well outfit samples must match a player's scan to back their face (or agree with them on a
 * hiding body's frame): the sample itself, and this body's samples on average since its last uncertain
 * transition (Track.outfitReads), so a lucky read of a suit that only resembles theirs backs nothing
 * and the reads after it take back what it gave. OUTFIT_VETO.clearSim (0.6) only says a sample does
 * not contradict a player, which is all lifting a veto needs; a suit like theirs clears it too, and
 * OUTFIT_RIVAL_LEAD refuses it only when the wearer's own scan explains it better. With nobody enrolled
 * in it (a bystander, a face-only practice target) there is no rival, and until this bar the suit
 * backed the face of every player it resembled (review of 2026-10-02: bench &stranger=1 on
 * antony-blinken/08, LOCK and a hit on P1 with P2, left out of the candidates, under the dot; sim
 * bystander-suit 228 wrong hits in 100 seeds, faceonly-suit 434). The average leaves out samples that
 * contradict the player (OUTFIT_VETO.maxSim), which veto them anyway: counted, a glitching sampler (sim
 * vetoed-player, a quarter of samples another colour) kept the player's own outfit from backing their
 * face for several reads after each glitch, 5 points of hits.
 *
 * Measured 2026-10-02 on the realcheck stills (135 people scanned from a close crop and read in the
 * group view at full and 0.6 size): a player's own outfit p5 0.78, p10 0.81, 96% of reads at 0.75 or
 * more in the light of the scan; after a change of light the camera's exposure and white balance
 * correct (dimmer, brighter, warmer, cooler), p10 0.74 and 90% (92% at 0.70, 95% at clearSim). Other
 * people in the same photo against a scan: p90 0.72, 7% at 0.75 or more (near-identical clothes, which
 * no outfit bar can separate); the dark suits on antony-blinken/08 0.65 to 0.75 against each other's
 * scans. Sim, suits averaging 0.63 / 0.67 / 0.72 like her scan (bystander-suit with share 0.65 / 0.7 /
 * 0.75, 300 seeds): with the read over time 0.68 / 0.72 / about 0.8 refuse them (0.75 leaves 5
 * wrong-lock frames on the last); 0.75 on each sample alone leaves 2 and 93 wrong hits on the last two.
 * 0.75 is the lowest bar that keeps the real photo's suits (up to 0.75 alike in one read) out of reach;
 * 0.70 also passed 15 bench runs on it.
 */
export const OUTFIT_BACK_MIN = 0.75;
/**
 * While a body overlaps someone (or its face association is ambiguous) the track may hop between
 * them without any transition, carrying the belief across; a hit then needs this body's latest face
 * read to come from a frame captured at most this long before the body's latest frame and, on its
 * own, to name the same player clearly (crossing-lookalike-faces seed 4, 2026-10-01: a belief
 * carried from the crossing partner hit him while she was under the dot). Capture time against
 * capture time: on a slow phone the decision comes more than this long after the capture, so the
 * decision clock would refuse even a read from the deciding frame itself.
 */
export const OVERLAP_FACE_FRESH_MS = 400;
/** A single-frame face naming another player than the track believes, by this lead over the rest, is a hop onto another body. */
export const HOP_READ_MARGIN = 0.2;
/**
 * MoveNet MultiPose returns at most this many bodies (human.ts body.maxDetected). A frame at the cap
 * may be missing a seventh person, who can stand inside a detected body's box or take its track
 * when the six returned change from frame to frame; a hit then needs this body's own face read, from
 * a frame within OVERLAP_FACE_FRESH_MS of its latest one, as during an overlap, and the HUD says why
 * ("Too many people in view").
 */
export const BODY_CAP = 6;
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
/** A live sample must be this similar to the player's own scan: other people's frames reach 0.50 at the 99.9th percentile on GhostNet (2026-10-01). */
export const LIVE_FACE_ENROLLED_MIN = 0.5;
export const LIVE_FACE_MIN_BELIEF = 0.85;
export const LIVE_FACE_MIN_TRACK_SAMPLES = 3;
export const LIVE_FACE_NOVELTY = 0.85;
