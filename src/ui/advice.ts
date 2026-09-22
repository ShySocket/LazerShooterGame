import { LOAD_CALIB } from '../vision/calibration';
import { isTimeout } from '../net/withTimeout';

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

/** Why a scan could not be saved, in plain words, so the player knows whether to retry or to fix the room. */
export function saveError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  const code = (e as { code?: string } | null)?.code ?? '';
  const text = `${code} ${raw}`.toLowerCase();
  if (/permission/.test(text)) return 'Could not save the scan: the server refused it. Ask the host to check the room, then try again.';
  if (/network|offline|failed to fetch|unavailable|disconnected/.test(text)) return 'Could not save the scan: no connection. Try again when the Wi-Fi is back.';
  if (/timeout|timed out/.test(text)) return 'Could not save the scan: the connection timed out. Try again.';
  return `Could not save the scan: ${raw || 'unknown error'}. Try again.`;
}

export interface LobbyState {
  /** Names of enrolled players whose phone is currently disconnected. */
  disconnectedEnrolled: string[];
  /** Enrolled and connected players. */
  enrolledConnected: number;
  notEnrolled: string[];
  stale: string[];
  conflicts: number;
  minPlayers: number;
}

const list = (names: string[]) => (names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

/** The one sentence under a disabled Start: a phone that dropped is named before "need 2 players" is claimed. */
export function lobbyHint(s: LobbyState): string {
  if (s.disconnectedEnrolled.length && s.enrolledConnected < s.minPlayers) {
    return s.disconnectedEnrolled.length === 1
      ? `Waiting for ${possessive(s.disconnectedEnrolled[0])} phone to reconnect.`
      : `Waiting for ${list(s.disconnectedEnrolled)} to reconnect.`;
  }
  if (s.enrolledConnected < s.minPlayers) return `Need at least ${s.minPlayers} enrolled players.`;
  if (s.notEnrolled.length) return `Waiting for ${list(s.notEnrolled)} to enroll.`;
  if (s.stale.length) return `${list(s.stale)} need${s.stale.length === 1 ? 's' : ''} to redo an outdated scan.`;
  if (s.conflicts) return 'Resolve the clothing conflict above.';
  return '';
}

/** When neither the share sheet nor the clipboard works, the code itself is the fallback. */
export const shareFallback = (code: string): string => `Could not copy. The code is ${code}.`;

export const HIT_CONFIDENCE_NOTE = '0.5 suits most rounds. Above 0.7 few shots can land, so the field stops there.';
export const MUTE_SWITCH_NOTE = 'On an iPhone, sounds stay off while the mute switch is on.';

/**
 * The second line under a HUD verdict: what the player can do about it. Hits and a clean miss need
 * none; every refusal names the one thing that helps.
 */
export function verdictAdvice(text: string): string {
  switch (text) {
    case 'UNCLEAR TARGET':
      return 'Get closer or wait for the green name.';
    case 'NOT A PLAYER':
      return 'Nobody enrolled looks like that.';
    case 'THAT IS YOU':
      return 'A mirror, or your own reflection.';
    case 'CAMERA TOO SLOW':
      return 'More light, and close other apps.';
    case 'NO FRESH FRAMES':
      return 'The camera stopped. Tap Retry if it stays.';
    case 'NO CAMERA LOCK':
      return 'Wait a moment for the camera to catch up.';
    case 'SHOT LOST':
      return 'The app was interrupted mid-shot. Fire again.';
    case 'NO CONNECTION, SHOT LOST':
      return 'Check the Wi-Fi; hits need the network.';
    default:
      return '';
  }
}

export const RANGE_TARGET_NOTE = 'Choose who you are aiming at to enable FIRE.';

/** A waiting build is applied only when nothing on this phone would be lost by a reload. */
export function updateAllowed(state: { inRoom: boolean; profileOpen: boolean; inputFocused: boolean }): boolean {
  return !state.inRoom && !state.profileOpen && !state.inputFocused;
}

export interface CrashNotice {
  title: string;
  summary: string;
  details: string;
}

/** The crash diary in plain words: what the player should know first, the raw text behind a toggle. */
export function crashNotice(incident: { t: number; kind: 'error' | 'rejection' | 'reload'; message: string }): CrashNotice {
  const when = new Date(incident.t).toLocaleTimeString();
  const room = incident.message.match(/room ([A-Z]{4})/)?.[1];
  const summary =
    incident.kind === 'reload'
      ? `The page reloaded on its own${room ? ` while in room ${room}` : ''} at ${when}. Rejoining should have brought you back; if not, join again with the code.`
      : `Something in the app failed at ${when} and it had to restart. Your enrolment and room are unaffected; if it happens again, tell the host.`;
  return { title: 'The app restarted unexpectedly', summary, details: `${incident.kind}: ${incident.message}` };
}

export const REVIEW_SKIP_ONE = 'Skip this shot';
export const REVIEW_DONE = 'Done reviewing';
export const RESET_FAILED = 'Could not reset the room. Check the connection and tap again.';

/** The banner for a hit the server never confirmed: offline or timed out is a lost shot, anything else is refused. */
export function hitFailureText(e: unknown): string {
  const text = (e instanceof Error ? `${e.name} ${e.message}` : String(e ?? '')).toLowerCase();
  if (isTimeout(e) || /network|offline|disconnected|unavailable/.test(text)) return 'NO CONNECTION, SHOT LOST';
  return 'SHOT LOST';
}

export const OFFLINE_TEXT = 'OFFLINE. Shots are not counting. Reconnecting…';
