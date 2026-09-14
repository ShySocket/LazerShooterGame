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
export const SAMPLE_VERSION = 1;

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
  /** Centred cosine of the frame's face embedding and of the track's running mean against each gallery. */
  face?: { sims: Record<Pid, number>; meanSims: Record<Pid, number>; quality: number };
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
}

export interface FrameSummary {
  /** Capture time relative to the tap, ms (negative before it). */
  t: number;
  tracks: TrackSummary[];
  lock: string | null;
}

export type ShotLabel = { kind: 'player'; target: Pid; answeredAt: number; reviewMs: number } | { kind: 'none'; answeredAt: number; reviewMs: number };

export interface ShotSample {
  v: number;
  app: { commit: string; faceModel: string; bodyModel: string; ua: string };
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
