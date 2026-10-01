import { SCAN_CALIB } from './calibration';
import type { NBox } from './geometry';

export { SCAN_CALIB };

/**
 * The enrolment face scan as pure decisions, so the prompts can be tested without a camera: which
 * head angle each prompt wants, whether a measured yaw/pitch satisfies it and if not what the
 * player should change, the short hold before a sample counts, and the same-person rule.
 */
export interface FacePrompt {
  text: string;
  /** Required absolute yaw band in degrees. */
  yaw?: [number, number];
  /** Which side relative to the first turned sample: 'a' and 'b' must have opposite signs. */
  side?: 'a' | 'b';
  /** Chin up or down: opposite pitch signs, latched on the first tilt. */
  tilt?: 'up' | 'down';
}

export const FACE_PROMPTS: FacePrompt[] = [
  { text: 'Look straight at the camera', yaw: SCAN_CALIB.straightYaw },
  { text: 'Turn your head slightly to the left', yaw: SCAN_CALIB.slightYaw, side: 'a' },
  { text: 'Turn your head slightly to the right', yaw: SCAN_CALIB.slightYaw, side: 'b' },
  { text: 'Turn a little further left', yaw: SCAN_CALIB.furtherYaw, side: 'a' },
  { text: 'Turn a little further right', yaw: SCAN_CALIB.furtherYaw, side: 'b' },
  { text: 'Tilt your chin up', tilt: 'up' },
  { text: 'Tilt your chin down', tilt: 'down' },
  { text: 'Smile, or make a face' },
];

export const promptFor = (index: number): FacePrompt => FACE_PROMPTS[Math.min(index, FACE_PROMPTS.length - 1)];

export type PoseReason = 'ok' | 'turn-more' | 'turn-less' | 'other-way' | 'tilt-more' | 'tilt-less' | 'straighten';

export interface ScanState {
  /** Sign of the yaw that counts as side 'a', 0 until the first turned sample. */
  yawSign: number;
  /** Sign of the pitch that counts as chin up, 0 until the first tilted sample. */
  pitchSign: number;
  /** Consecutive frames that satisfied the current prompt. */
  hold: number;
}

export const initialScanState = (): ScanState => ({ yawSign: 0, pitchSign: 0, hold: 0 });

export interface Judgement {
  ok: boolean;
  reason: PoseReason;
  /** Conventions learned from this frame, to store when the sample is accepted. */
  latch: Partial<Pick<ScanState, 'yawSign' | 'pitchSign'>>;
}

/** Does this head angle satisfy the prompt? If not, the one thing the player should change. */
export function judgePose(prompt: FacePrompt, yawDeg: number, pitchDeg: number, state: ScanState): Judgement {
  const latch: Judgement['latch'] = {};
  if (prompt.yaw) {
    const [lo, hi] = prompt.yaw;
    const abs = Math.abs(yawDeg);
    if (abs > hi) return { ok: false, reason: prompt.side ? 'turn-less' : 'straighten', latch };
    // Below the band the sign is noise, so ask for more before judging the direction.
    if (abs < lo) return { ok: false, reason: 'turn-more', latch };
    if (prompt.side) {
      const sign = Math.sign(yawDeg) || 1;
      const wantA = prompt.side === 'a';
      if (state.yawSign === 0) latch.yawSign = wantA ? sign : -sign;
      else if (sign !== (wantA ? state.yawSign : -state.yawSign)) return { ok: false, reason: 'other-way', latch };
    }
  }
  if (prompt.tilt) {
    const [lo, hi] = SCAN_CALIB.tiltPitch;
    const abs = Math.abs(pitchDeg);
    if (abs > hi) return { ok: false, reason: 'tilt-less', latch };
    if (abs < lo) return { ok: false, reason: 'tilt-more', latch };
    const sign = Math.sign(pitchDeg) || 1;
    const wantUp = prompt.tilt === 'up';
    if (state.pitchSign === 0) latch.pitchSign = wantUp ? sign : -sign;
    else if (sign !== (wantUp ? state.pitchSign : -state.pitchSign)) return { ok: false, reason: 'other-way', latch };
  }
  return { ok: true, reason: 'ok', latch };
}

/**
 * The hold: a prompt must be satisfied for `holdFrames` consecutive frames. Returns the next state
 * and whether the sample may be taken now. A failed frame resets the hold; an accepted sample stores
 * the conventions the judgement learned and resets the hold for the next prompt.
 */
export function holdStep(state: ScanState, judgement: Judgement, holdFrames = SCAN_CALIB.holdFrames): { state: ScanState; ready: boolean } {
  if (!judgement.ok) return { state: { ...state, hold: 0 }, ready: false };
  const hold = state.hold + 1;
  if (hold < holdFrames) return { state: { ...state, hold }, ready: false };
  return { state: { ...state, ...judgement.latch, hold: 0 }, ready: true };
}


/**
 * The face box is large enough for a trustworthy enrolment embedding, measured in full-frame pixels:
 * `copyScale` is the detect copy's width over the camera's (1 for a full-size copy), so a 720p phone
 * that got no downscale is not held to a stricter bar than a 1080p one that did.
 */
export const faceBigEnough = (widthPx: number, heightPx: number, min = SCAN_CALIB.minFacePx, copyScale = 1): boolean => Math.min(widthPx, heightPx) / (copyScale || 1) >= min;

export type FaceGateReason = 'ok' | 'no-face' | 'many-faces' | 'low-light' | 'crop';

/**
 * The cheap gates before a face sample: how many faces, how sure the detector is, and whether the
 * magnified crop found the same single face. A low score is poor light or a clipped face, so the
 * hint says light, never "hold still".
 */
export function faceGate(input: { faces: number; score?: number; cropCount?: number; cropOverlap?: number }, minScore = SCAN_CALIB.minFaceScore, minOverlap = SCAN_CALIB.minCropOverlap): FaceGateReason {
  if (input.faces === 0) return 'no-face';
  if (input.faces > 1) return 'many-faces';
  if (input.score !== undefined && input.score < minScore) return 'low-light';
  if (input.cropCount !== undefined && (input.cropCount !== 1 || (input.cropOverlap ?? 0) < minOverlap)) return 'crop';
  return 'ok';
}

export function gateHint(reason: FaceGateReason): string {
  switch (reason) {
    case 'ok':
      return '';
    case 'no-face':
      return 'No face found. Move closer and face the camera.';
    case 'many-faces':
      return 'Only one face in frame please.';
    case 'low-light':
      return 'Move into better light and face the camera.';
    case 'crop':
      return 'Keep just your face in the frame.';
  }
}


/** What to tell the player, given the prompt and why the frame did not count. */
export function hintFor(prompt: FacePrompt, reason: PoseReason): string {
  switch (reason) {
    case 'ok':
      return 'Hold it…';
    case 'turn-more':
      return prompt.side ? 'Turn a bit more, then hold it.' : 'Look straight at the camera.';
    case 'turn-less':
      return 'Turn back a little, then hold it.';
    case 'straighten':
      return 'Look straight at the camera.';
    case 'other-way':
      return prompt.tilt ? `The other way: chin ${prompt.tilt}.` : 'The other way.';
    case 'tilt-more':
      return prompt.tilt === 'up' ? 'Chin up a little more.' : 'Chin down a little more.';
    case 'tilt-less':
      return 'Not quite that far. Ease back a little.';
  }
}

// ---- Patience: no prompt can dead-end -------------------------------------------------------------

/**
 * How far this frame went towards the prompt, in degrees and in the direction the prompt wants
 * (-Infinity the wrong way). A straight prompt scores the closer to 0, the better.
 */
export function promptProgress(prompt: FacePrompt, yawDeg: number, pitchDeg: number, state: ScanState): number {
  if (prompt.tilt) {
    const want = state.pitchSign === 0 ? Math.sign(pitchDeg) : prompt.tilt === 'up' ? state.pitchSign : -state.pitchSign;
    return Math.sign(pitchDeg) === want ? Math.abs(pitchDeg) : -Infinity;
  }
  if (prompt.side) {
    const want = state.yawSign === 0 ? Math.sign(yawDeg) : prompt.side === 'a' ? state.yawSign : -state.yawSign;
    return Math.sign(yawDeg) === want ? Math.abs(yawDeg) : -Infinity;
  }
  if (prompt.yaw) return -Math.abs(yawDeg);
  return 0;
}

/**
 * After `patienceMs` on a prompt, whether the best frame seen may stand in for it: a turn or tilt
 * that went at least `fraction` of the way to the band, or a "straight" within twice its band.
 */
export function patienceAccepts(prompt: FacePrompt, best: number, elapsedMs: number, patienceMs = SCAN_CALIB.promptPatienceMs, fraction = SCAN_CALIB.patienceFraction): boolean {
  if (elapsedMs < patienceMs || !Number.isFinite(best)) return false;
  if (prompt.tilt) return best >= SCAN_CALIB.tiltPitch[0] * fraction;
  if (prompt.side && prompt.yaw) return best >= prompt.yaw[0] * fraction;
  if (prompt.yaw) return -best <= prompt.yaw[1] * 2;
  return true;
}

/** The conventions a patience-accepted frame latches, as a normal accepted sample would. */
export function patienceLatch(prompt: FacePrompt, yawDeg: number, pitchDeg: number, state: ScanState): Partial<Pick<ScanState, 'yawSign' | 'pitchSign'>> {
  if (prompt.side && state.yawSign === 0) return { yawSign: prompt.side === 'a' ? Math.sign(yawDeg) || 1 : -(Math.sign(yawDeg) || 1) };
  if (prompt.tilt && state.pitchSign === 0) return { pitchSign: prompt.tilt === 'up' ? Math.sign(pitchDeg) || 1 : -(Math.sign(pitchDeg) || 1) };
  return {};
}

export const canSkipAngle = (elapsedMs: number, skipMs = SCAN_CALIB.promptSkipMs): boolean => elapsedMs >= skipMs;
export const SKIP_ANGLE_TEXT = 'Skip this angle';

/** The live angle against the target, for "turn more" and "tilt more": phones read a turn as less than it feels. */
export function angleNote(prompt: FacePrompt, reason: PoseReason, yawDeg: number, pitchDeg: number): string {
  if (reason === 'turn-more' && prompt.side && prompt.yaw) return `Now ${Math.round(Math.abs(yawDeg))}°, aim for ${prompt.yaw[0]}°.`;
  if (reason === 'tilt-more' && prompt.tilt) return `Now ${Math.round(Math.abs(pitchDeg))}°, aim for ${SCAN_CALIB.tiltPitch[0]}°.`;
  return '';
}

// ---- The whole face stage as one pure step (Scanner.tsx and scripts/realcheck.ts replay call it) --

/** One camera frame as the face stage sees it, after the detector, the size gate and the crop. */
export interface FaceObs {
  /** Capture time, ms. */
  t: number;
  /** Faces the full-frame pass found, and the box of the face when there is exactly one. */
  faces: number;
  box: NBox | null;
  /** Why this frame cannot give a sample (a gate hint), '' when it can. */
  blocked: string;
  yaw: number;
  pitch: number;
  /** Unit embedding of the face from the square crop; empty when blocked. */
  embedding: number[];
}

export interface FaceFrame {
  embedding: number[];
  yaw: number;
  pitch: number;
  progress: number;
  t: number;
}

export interface FaceStage {
  scan: ScanState;
  samples: { embedding: number[]; yaw: number }[];
  /** When the current prompt began, and no sample before `settleUntil` (a pause after each one). */
  promptStart: number;
  settleUntil: number;
  best: FaceFrame | null;
  last: FaceFrame | null;
}

export const initialFaceStage = (t: number): FaceStage => ({ scan: initialScanState(), samples: [], promptStart: t, settleUntil: t + SCAN_CALIB.settleMs, best: null, last: null });

export interface FaceStep {
  stage: FaceStage;
  hint: string;
  accepted: boolean;
  /** Skip this angle may be offered. */
  skippable: boolean;
}

function accept(st: FaceStage, fr: FaceFrame, scan: ScanState, latch: Partial<Pick<ScanState, 'yawSign' | 'pitchSign'>>, t: number): FaceStep {
  return {
    stage: { ...st, scan: { ...scan, ...latch, hold: 0 }, samples: [...st.samples, { embedding: fr.embedding, yaw: fr.yaw }], promptStart: t, settleUntil: t + SCAN_CALIB.settleMs, best: null },
    hint: '',
    accepted: true,
    skippable: false,
  };
}

/**
 * One frame of the face stage. Who is being scanned is the one face in frame: a frame with no face
 * or several gives no sample (the caller's `blocked`). Face similarity is deliberately not used here:
 * with GhostNet the same person turned, or even facing the camera in another frame, can score below
 * other people (npm run realcheck scan, 2026-10-01), so any similarity gate refuses real players,
 * which is what broke Sai's scan. A sample is taken on a held pose, or after the patience the best
 * right-way frame stands in; Skip this angle is offered later still.
 */
export function faceStageStep(st: FaceStage, obs: FaceObs): FaceStep {
  const skippable = canSkipAngle(obs.t - st.promptStart);
  if (obs.t < st.settleUntil) return { stage: st, hint: '', accepted: false, skippable: false };
  if (obs.blocked || !obs.embedding.length) return { stage: st, hint: obs.blocked || 'Hold still and face the camera a little more.', accepted: false, skippable: skippable && Boolean(st.last) };
  const prompt = promptFor(st.samples.length);
  let judgement = judgePose(prompt, obs.yaw, obs.pitch, st.scan);
  if (judgement.ok && Math.abs(obs.yaw) > SCAN_CALIB.enrolYawMax) judgement = { ok: false, reason: 'turn-less', latch: {} };
  const fr: FaceFrame = { embedding: obs.embedding, yaw: obs.yaw, pitch: obs.pitch, progress: promptProgress(prompt, obs.yaw, obs.pitch, st.scan), t: obs.t };
  const best = Math.abs(obs.yaw) <= SCAN_CALIB.enrolYawMax && (!st.best || fr.progress > st.best.progress) ? fr : st.best;
  let stage: FaceStage = { ...st, last: fr, best };
  const held = holdStep(stage.scan, judgement);
  if (held.ready) return accept(stage, fr, held.state, {}, obs.t);
  stage = { ...stage, scan: held.state };
  if (best && patienceAccepts(prompt, best.progress, obs.t - stage.promptStart)) return accept(stage, best, stage.scan, patienceLatch(prompt, best.yaw, best.pitch, stage.scan), obs.t);
  return { stage, hint: [hintFor(prompt, judgement.reason), angleNote(prompt, judgement.reason, obs.yaw, obs.pitch)].filter(Boolean).join(' '), accepted: false, skippable };
}

/** Skip this angle: the face's last frame stands in, if it was seen within the last 1.5 s (null otherwise). */
export function skipFaceAngle(st: FaceStage, t: number): FaceStep | null {
  const fr = st.last;
  if (!fr || t - fr.t > 1500) return null;
  return accept(st, fr, st.scan, patienceLatch(promptFor(st.samples.length), fr.yaw, fr.pitch, st.scan), t);
}

// ---- Body stages ---------------------------------------------------------------------------------

export type BodySampleDecision = 'take' | 'skip' | 'restart';

/**
 * Whether this frame's body box may add an outfit sample. A box that moved a lot since the last
 * sample (a step, the phone shifting) is skipped, not punished: the samples already taken stay and
 * the next steady frame counts again. Only a real gap, longer than `gapMs` without a usable body,
 * throws the samples away, because by then the person may have changed or left.
 */
export function bodySampleDecision(lastBox: NBox | null, box: NBox, now: number, lastSampleAt: number, boxOverlap: (a: NBox, b: NBox) => number, gapMs = SCAN_CALIB.bodyGapMs, minOverlap = SCAN_CALIB.bodyMinOverlap): BodySampleDecision {
  if (!lastBox || !lastSampleAt) return 'take';
  if (now - lastSampleAt > gapMs) return 'restart';
  if (boxOverlap(lastBox, box) < minOverlap) return 'skip';
  return 'take';
}

/**
 * The front body stage keeps recording after the outfit is complete until it has `minFarFaces`
 * face samples from that distance, or `patienceMs` have passed since the outfit completed.
 */
export function farFacesDone(frontStage: boolean, farFaces: number, outfitDoneAt: number, now: number, minFarFaces = SCAN_CALIB.minFarFaces, patienceMs = SCAN_CALIB.farFacePatienceMs): boolean {
  if (!frontStage) return true;
  if (farFaces >= minFarFaces) return true;
  return outfitDoneAt > 0 && now - outfitDoneAt > patienceMs;
}

/**
 * Somebody else in the frame (a bystander, a poster, a mirror) pauses the body scan and keeps the
 * samples already taken; only when the intrusion lasts longer than `gapMs` does the scan start over,
 * because by then the samples may belong to the wrong person.
 */
export function bystanderDecision(intrudingSince: number, now: number, gapMs = SCAN_CALIB.bodyGapMs): 'pause' | 'restart' {
  return now - intrudingSince > gapMs ? 'restart' : 'pause';
}

/** The settle before sampling counts from the first usable body frame, not from a countdown that ended while the player was still walking. */
export function settleDone(firstUsableAt: number, now: number, settleMs = SCAN_CALIB.bodySettleMs): boolean {
  return firstUsableAt > 0 && now - firstUsableAt >= settleMs;
}

export const STEP_BACK_TEXT = 'Shoulders and hips must both be visible. Step back so more of you fits.';
export const SMALL_ROOM_TEXT = 'No room to step back? Raise the phone and tilt it down. A scan without the legs still counts.';

/** The step-back hint, and after `hintMs` of it the alternative for a small room. */
export function smallRoomHint(stepBackSince: number, now: number, hintMs = SCAN_CALIB.smallRoomHintMs): string {
  return stepBackSince > 0 && now - stepBackSince > hintMs ? `${STEP_BACK_TEXT} ${SMALL_ROOM_TEXT}` : STEP_BACK_TEXT;
}
