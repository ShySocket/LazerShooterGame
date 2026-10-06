import { currentPrompt, EXTRA_ANY, lapPrompts, promptIndex, SCAN_CALIB, type FacePrompt, type FaceStage, type FaceStep } from './scan';

/**
 * The face-scan ring as pure geometry, so the picture can be tested without a camera: where the live
 * head angle puts the dot, which zone each prompt lights, and which way the arrow points when a frame
 * did not count. Coordinates are unit screen space: x right, y down, the ring at radius 1.
 *
 * The ring is laid out like a mirror: side 'a' (the first prompt says "left") is screen left, chin up
 * is the top. Once a turn or tilt is latched (scan.ts ScanState), the dot follows the latched sign,
 * so it moves the way the player moved however the phone reports the angle. Before the latch the dot
 * uses SCREEN_YAW_SIGN / SCREEN_PITCH_SIGN, the sign the model reports in the mirrored selfie preview.
 */

/**
 * Model yaw to screen x before the left/right latch: in the mirrored preview a face pointing screen
 * left reads negative yaw (seen on fixtures/real/clips/headturn.mp4 through the real models, 2026-10-06).
 */
export const SCREEN_YAW_SIGN = 1;
/** Model pitch to screen y before the chin latch; not yet seen on a phone (after the latch the sign is the player's own). */
export const SCREEN_PITCH_SIGN = -1;
/** Head angles that reach the ring's edge. */
export const YAW_FULL = SCAN_CALIB.furtherYaw[1];
export const PITCH_FULL = SCAN_CALIB.tiltPitch[1];

export type ZoneKey = 'centre' | 'expression' | 'slight-a' | 'slight-b' | 'further-a' | 'further-b' | 'up' | 'down';
export type ZoneState = 'todo' | 'target' | 'locked' | 'skipped';
export type Pt = [number, number];

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** The screen direction (+1 right / down, -1 left / up) of a yaw or pitch, given the latched sign. */
const xSign = (yawSign: number) => (yawSign ? -yawSign : SCREEN_YAW_SIGN);
const ySign = (pitchSign: number) => (pitchSign ? -pitchSign : SCREEN_PITCH_SIGN);

/** Where a head angle puts the dot. */
export function dotPosition(yawDeg: number, pitchDeg: number, scan: { yawSign: number; pitchSign: number }): Pt {
  return [clamp((xSign(scan.yawSign) * yawDeg) / YAW_FULL), clamp((ySign(scan.pitchSign) * pitchDeg) / PITCH_FULL)];
}

export function zoneOf(prompt: FacePrompt): ZoneKey | null {
  if (prompt === EXTRA_ANY) return null;
  if (prompt.tilt) return prompt.tilt;
  if (prompt.side) return `${prompt.yaw && prompt.yaw[0] >= SCAN_CALIB.furtherYaw[0] ? 'further' : 'slight'}-${prompt.side}`;
  return prompt.yaw ? 'centre' : 'expression';
}

const mid = ([lo, hi]: [number, number]) => (lo + hi) / 2;

/** The dot position a zone wants: the middle of its band, on the side the layout gives it. */
export function zoneTarget(key: ZoneKey): Pt {
  switch (key) {
    case 'centre':
    case 'expression':
      return [0, 0];
    case 'slight-a':
    case 'slight-b':
      return [(key.endsWith('a') ? -1 : 1) * Math.min(1, mid(SCAN_CALIB.slightYaw) / YAW_FULL), 0];
    case 'further-a':
    case 'further-b':
      return [(key.endsWith('a') ? -1 : 1) * Math.min(1, mid(SCAN_CALIB.furtherYaw) / YAW_FULL), 0];
    case 'up':
      return [0, -Math.min(1, mid(SCAN_CALIB.tiltPitch) / PITCH_FULL)];
    case 'down':
      return [0, Math.min(1, mid(SCAN_CALIB.tiltPitch) / PITCH_FULL)];
  }
}

export interface Zone {
  key: ZoneKey;
  state: ZoneState;
}

/** Every zone of the current lap and its state. */
export function zoneStates(st: FaceStage): Zone[] {
  const idx = promptIndex(st);
  const target = zoneOf(currentPrompt(st));
  const done = (i: number): ZoneState => (st.skippedAt.includes(i) ? 'skipped' : 'locked');
  return lapPrompts(st).map((p, i) => {
    const key = zoneOf(p)!;
    const state: ZoneState = i < idx ? done(i) : key === target ? 'target' : 'todo';
    return { key, state };
  });
}

export type ArrowKind = 'none' | 'to' | 'flip' | 'either-x' | 'either-y' | 'further';

export interface Arrow {
  kind: ArrowKind;
  from: Pt;
  to: Pt;
}

const NONE: Arrow = { kind: 'none', from: [0, 0], to: [0, 0] };

/**
 * Which way to move, given the frame's dot and why it did not count. A first turn or tilt may go
 * either way (the latch), so the arrow is double-headed until then; the wrong way flips it.
 */
export function arrowFor(st: FaceStage, reason: FaceStep['reason'], dot: Pt | null): Arrow {
  if (reason === 'further') return { kind: 'further', from: [0, 0], to: [0, 0] };
  if (!dot || reason === 'ok' || reason === 'wait' || reason === 'blocked') return NONE;
  const prompt = currentPrompt(st);
  const key = zoneOf(prompt);
  if (!key) return NONE;
  const to = zoneTarget(key);
  if (prompt.side && !st.scan.yawSign) return { kind: 'either-x', from: dot, to: [Math.abs(to[0]), 0] };
  if (prompt.tilt && !st.scan.pitchSign) return { kind: 'either-y', from: dot, to: [0, Math.abs(to[1])] };
  return { kind: reason === 'other-way' ? 'flip' : 'to', from: dot, to };
}
