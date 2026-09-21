import { SCAN_CALIB } from './calibration';
import { faceSimilarity } from './embedding';
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

/** A sample is the same person when it matches any accepted sample: a turned head chains through the adjacent angle. */
export function samePerson(candidate: number[], accepted: number[][], min = SCAN_CALIB.samePerson, sim: (a: number[], b: number[]) => number = faceSimilarity): boolean {
  if (!accepted.length) return true;
  return accepted.some((a) => sim(candidate, a) >= min);
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

export const SAME_FACE_TEXT = 'This looks like a different face than the earlier frames: better light, hat and glasses off, or Restart scan.';

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
