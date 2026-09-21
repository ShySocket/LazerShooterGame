import { LOAD_CALIB } from '../vision/calibration';

/**
 * Player-facing words for the moments an app can leave a phone stuck: what a wait is doing, when it
 * has gone on too long, and why something failed. Pure functions so every message has a test and no
 * screen decides wording on its own.
 */

export interface ModelStat {
  name: string;
  loaded: boolean;
  sizeLoadedWeights?: number;
}

export interface LoadProgress {
  text: string;
  loaded: number;
  total: number;
  bytes: number;
}

/** "Loading models 2 of 4 (9 MB)" from Human's model stats, counting only the models the game needs. */
export function loadProgress(stats: ModelStat[], required: string[]): LoadProgress {
  const needed = required.map((name) => stats.find((s) => s.name === name)).filter((s): s is ModelStat => Boolean(s));
  const loaded = needed.filter((s) => s.loaded).length;
  const bytes = stats.reduce((sum, s) => sum + (s.sizeLoadedWeights ?? 0), 0);
  const mb = bytes >= 1_000_000 ? ` (${Math.round(bytes / 1_000_000)} MB)` : '';
  return { text: `Loading models ${loaded} of ${required.length}${mb}`, loaded, total: required.length, bytes };
}

export const STALL_TEXT = 'Download stalled. Check the Wi-Fi and tap Retry.';

/** A download whose loaded count has not moved for `stallMs` is stalled. */
export const isStalled = (sinceLastProgressMs: number, stallMs = LOAD_CALIB.modelStallMs): boolean => sinceLastProgressMs > stallMs;

export interface ConnectState {
  text: string;
  showBack: boolean;
}

/** A wait says what it is; past the patience it admits it is taking long and offers a way out. */
export function connectState(base: string, elapsedMs: number, patienceMs = LOAD_CALIB.connectPatienceMs): ConnectState {
  if (elapsedMs < patienceMs) return { text: base, showBack: false };
  return { text: `Still ${base.charAt(0).toLowerCase()}${base.slice(1)}… this is taking longer than usual. Check the connection or go back.`, showBack: true };
}

/** Why a reload could not put the phone back in its room, in the player's words. */
export function rejoinFailure(code: string, result: 'missing' | 'in-progress' | 'ok' | Error | string): string {
  if (result === 'missing') return `Could not rejoin room ${code}: it no longer exists.`;
  if (result === 'in-progress') return `Could not rejoin room ${code}: a round is in progress and you were not in it. Ask the host for the link again once they are back in the lobby.`;
  const reason = result instanceof Error ? result.message : typeof result === 'string' ? result : 'unknown error';
  return `Could not rejoin room ${code}: ${reason}. Check the connection and join again.`;
}
