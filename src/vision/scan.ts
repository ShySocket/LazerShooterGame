import { SCAN_CALIB } from './calibration';
import { faceSimilarity } from './embedding';

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

/** The face box (in pixels) is large enough for a trustworthy enrolment embedding. */
export const faceBigEnough = (widthPx: number, heightPx: number, min = SCAN_CALIB.minFacePx): boolean => Math.min(widthPx, heightPx) >= min;

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
