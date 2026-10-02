import type { BodyProps, OutfitSig, Profile, RoomSettings } from '../types';
import { UNKNOWN_ID } from '../types';
import type { NBox } from '../vision/geometry';

/**
 * Shot feedback samples: what a phone uploads after the shooter has labelled one of their failed
 * shots on the results screen. A sample is the deconstruction of the shot, never the photo: the
 * beliefs and raw similarities the pipeline saw frame by frame, the target's numeric signatures, the
 * settings, and the label. Player ids are replaced by positional ids (p0, p1, ...) and names are
 * never included, so a sample cannot be tied back to a person outside the room that produced it.
 */
export const SAMPLE_VERSION = 3;
// v3 (2026-10-01): the rule that refused a shot (shot.refusal) and the in-sight body's lock refusal per
// frame; per track whether a partner was presumed hidden behind it (hiding, added within v3 before any
// v3 build reached main, so a v3 sample without it is judged on its recorded unconfirmed flag); and the
// face similarities are taken against the galleries the pipeline scored with, live-learned faces included.
// v2 (2026-10-01, Astra review): app.calibration; per-track vetoes, clothing age, uncertainty, overlap,
// crowd and fresh-face flags, and whose outfit backed each face read; per-frame body count; practice
// labels carry the shot's conditions and whether they came from ?practice or a real room's range test.

/** Anonymised player id: `p<n>` for the n-th enrolled id in sorted order, or `unknown` for the stranger baseline. */
export type Pid = string;
export const UNKNOWN_PID = 'unknown';

export interface OutfitMatchSummary {
  sim: number;
  /** Share of the outfit compared; 1 on builds that compare whole outfits without a coverage measure. */
  cov: number;
  /** Whether the trousers were compared; true on builds that do not track it. */
  thighs: boolean;
}

/** Raw evidence a track received in one frame, per candidate, before calibration turned it into belief. */
export interface EvidenceSummary {
  /**
   * Centred cosine of the frame's face embedding and of the track's running mean against each gallery.
   * v2 `corroborated`: the players whose own recent outfit backed the face on this body (scoring.ts
   * outfitSupports), judged at FACE_CALIB; everyone else at FACE_ONLY_CALIB. Missing means nobody (the
   * database drops empty arrays).
   */
  face?: { sims: Record<Pid, number>; meanSims: Record<Pid, number>; quality: number; corroborated?: Pid[] };
  outfit?: { match: Record<Pid, OutfitMatchSummary>; body?: Record<Pid, number> };
}

export interface TrackSummary extends EvidenceSummary {
  id: number;
  box: NBox;
  hit: NBox;
  /** Belief after this frame, as published (claimed view when assigned). */
  belief: Record<Pid, number>;
  via: string;
  conflict: boolean;
  ambiguous: boolean;
  faceSamples: number;
  faceAgeMs: number | null;
  evidenceAgeMs: number | null;
  inSight: boolean;
  /** v2: players the outfit currently rules out on this body (OUTFIT_VETO). */
  vetoed?: Pid[];
  /** v2: time since this body's last readable outfit sample, null when it never had one. */
  clothingAgeMs?: number | null;
  /** v2: the identity was dropped after an uncertain transition and has not been re-earned yet. */
  unconfirmed?: boolean;
  reacquiring?: boolean;
  /** v2: overlapping another body this frame (the overlap rule applies). */
  overlapping?: boolean;
  /** v2: the frame held the detector's full BODY_CAP bodies (the crowd rule applies). */
  crowded?: boolean;
  /** v2: a face crop was read on this body in this frame, not carried from an earlier one (information only: the replay's overlap/crowd gate follows the reads themselves). */
  freshFace?: boolean;
  /**
   * v3: a partner was presumed hidden behind this body (tracker.ts Track.hiding), so only this frame's
   * own reads could confirm its identity. A sample with this field lets the replay keep `unconfirmed`
   * itself, from the recorded reads under its own parameters, instead of trusting the recorded flag
   * (which is the game's calibration's verdict).
   */
  hiding?: boolean;
}

export interface FrameSummary {
  /** Capture time relative to the tap, ms (negative before it). */
  t: number;
  tracks: TrackSummary[];
  lock: string | null;
  /** v2: bodies the pose model returned in this frame. */
  bodies?: number;
  /** v3: why the body in sight would not have been a hit in this frame (scoring.ts Refusal). */
  refusal?: string | null;
}

/** How a practice shot was set up, chosen on the phone before the tap; the session report breaks results down by these. */
export const PRACTICE_VIEWS = ['front', 'side', 'back'] as const;
export const PRACTICE_LIGHTING = ['normal', 'dim', 'backlit'] as const;
export const PRACTICE_SCENARIOS = ['still', 'walking', 'crossing', 'occlusion', 'pan', 'look-alike', 'edge'] as const;
export type PracticeView = (typeof PRACTICE_VIEWS)[number];
export type PracticeLighting = (typeof PRACTICE_LIGHTING)[number];
export type PracticeScenario = (typeof PRACTICE_SCENARIOS)[number];
export interface ShotConditions {
  /** Metres to the target. */
  distance?: number;
  view?: PracticeView;
  lighting?: PracticeLighting;
  scenario?: PracticeScenario;
  /**
   * Where a range-test shot came from: 'practice' (?practice, targets quick-enrolled with the rear
   * camera) or 'range' (debug > range in a real room, against players who did the normal scan).
   * Absent on review-card labels and on labels recorded before it existed.
   */
  source?: 'practice' | 'range';
}

export type ShotLabel = ({ kind: 'player'; target: Pid; answeredAt: number; reviewMs: number } | { kind: 'none'; answeredAt: number; reviewMs: number }) & ShotConditions;

export interface ShotSample {
  v: number;
  app: { commit: string; faceModel: string; bodyModel: string; ua: string; /** v2 */ calibration?: string };
  round: {
    key: string;
    code: string;
    startAt: number;
    settings: RoomSettings;
    players: number;
    shooter: Pid;
    /** Live opponents at the tap: the only ids a hit could have resolved to. */
    eligible: Pid[];
  };
  device: { periodMs: number | null; staleMs: number; burstMs: number; width: number; height: number };
  shot: {
    id: string;
    /** Milliseconds into the round. */
    roundMs: number;
    /** What the game said: miss, unclear, hit, eliminated, stale frame, ... */
    outcome: string;
    /** What fire() returned: instant, pending, miss, stale, no-camera. */
    kind: string;
    resolvedTo: Pid | null;
    via: string | null;
    resolveMs: number | null;
    zoom: boolean;
    /** Age of the newest finished frame at the tap. */
    frameAgeMs: number | null;
    allowanceMs: number | null;
    crosshair: NBox;
    /** Track nominated at the tap (under the dot, or coasting there), null when nobody was. */
    trackId: number | null;
    /** Index into `frames` of the newest frame known when the verdict was taken (the tap frame for an instant one). */
    decidedAtFrame: number;
    settledBy: 'tap' | 'frame' | 'timer';
    /** The body under the dot at decision time and its belief then; null when nobody was there. */
    decisionTrackId: number | null;
    decisionBelief: Record<Pid, number> | null;
    /** v3: why a shot with a body under the dot did not land (pipeline.ts ShotRefusal), null for a hit or a miss. */
    refusal?: string | null;
  };
  frames: FrameSummary[];
  target: {
    trackId: number;
    faceMean: number[] | null;
    faceSamples: number;
    outfit: OutfitSig | null;
    props: BodyProps | null;
    /** Face samples learned live for each player by the tap. */
    liveFaces: Record<Pid, number>;
  } | null;
  label?: ShotLabel;
}

/** Profiles of a round, keyed by anonymised id, stored once per round next to its samples. */
export type ProfilesSnapshot = Record<Pid, Profile>;

/** Stable, anonymous naming of the players of one round. */
export class IdMap {
  private readonly ids: string[];
  private readonly index = new Map<string, Pid>();

  constructor(playerIds: Iterable<string>) {
    this.ids = [...new Set(playerIds)].sort();
    this.ids.forEach((id, i) => this.index.set(id, `p${i}`));
  }

  pid(id: string): Pid {
    if (id === UNKNOWN_ID) return UNKNOWN_PID;
    return this.index.get(id) ?? 'other';
  }

  /** Anonymise a record keyed by player id, rounding the values. */
  record(values: Record<string, number>, digits = 3): Record<Pid, number> {
    const out: Record<Pid, number> = {};
    for (const [id, v] of Object.entries(values)) out[this.pid(id)] = round(v, digits);
    return out;
  }

  /** The real ids in the order that produced p0, p1, ...; kept on the phone only. */
  all(): string[] {
    return this.ids.slice();
  }
}

export function round(v: number, digits = 3): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function roundBox(b: NBox): NBox {
  return [round(b[0]), round(b[1]), round(b[2]), round(b[3])];
}

/** Feedback rounds are keyed by room code and start time, which is unique per round and a valid database key. */
export function roundKey(code: string, startAt: number): string {
  return `${code}-${Math.round(startAt)}`;
}

/** Outcomes the shooter is asked about: the shot did not land and the phone had a frame to show. */
export const REVIEWABLE_OUTCOMES = new Set(['miss', 'unclear', 'stale frame']);

export interface ReviewCandidate {
  id: string;
  outcome: string;
  /** Whether a body was under the dot at the tap: those can be labelled against a player. */
  hadTrack: boolean;
}

/**
 * The shot to ask about: a random failed shot, preferring those where a body was under the dot,
 * because "who was that" is the question that tunes recognition. `random` is 0..1.
 */
export function pickReviewShot<T extends ReviewCandidate>(shots: T[], random: () => number = Math.random): T | null {
  const pool = shots.filter((s) => REVIEWABLE_OUTCOMES.has(s.outcome));
  if (pool.length === 0) return null;
  const withTrack = pool.filter((s) => s.hadTrack);
  const from = withTrack.length > 0 ? withTrack : pool;
  return from[Math.min(from.length - 1, Math.floor(random() * from.length))];
}

/** Rough upload size guard: a sample beyond this is trimmed to its most recent frames. */
export const MAX_SAMPLE_BYTES = 300_000;

export function trimSample(sample: ShotSample, maxBytes = MAX_SAMPLE_BYTES): ShotSample {
  let s = sample;
  while (JSON.stringify(s).length > maxBytes && s.frames.length > 2) {
    const dropped = 1;
    s = { ...s, frames: s.frames.slice(dropped), shot: { ...s.shot, decidedAtFrame: s.shot.decidedAtFrame < 0 ? -1 : Math.max(0, s.shot.decidedAtFrame - dropped) } };
  }
  return s;
}
