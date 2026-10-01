import type { HitRecord, Player, Profile, Room, RoomMeta, RoomSettings } from '../types';
import { DEFAULT_SETTINGS, MIN_INVULN_MS, PLAYER_COLORS } from '../types';
import { NET_CALIB } from '../vision/calibration';
import type { ProfilesSnapshot, ShotSample } from '../feedback/sample';

export type HitOutcome = 'hit' | 'eliminated' | 'invulnerable' | 'dead' | 'invalid';
export type EndResult = 'ended' | 'already' | 'not-decided';
/** How long a host's phone may be disconnected before another player takes over. */
export const HOST_GRACE_MS = 10000;
export type JoinResult = 'ok' | 'missing' | 'in-progress';
export type PlayerSeed = Pick<Player, 'id' | 'name'>;

export interface RoomBackend {
  readonly mode: 'firebase' | 'local';
  createRoom(host: PlayerSeed): Promise<string>;
  /** New players are only admitted while the room is in the lobby; returning players may rejoin any time. */
  joinRoom(code: string, player: PlayerSeed): Promise<JoinResult>;
  /** Marks the player disconnected and stops presence tracking. */
  leaveRoom(code: string, id: string): Promise<void>;
  subscribe(code: string, cb: (room: Room | null) => void): () => void;
  updatePlayer(code: string, id: string, patch: Partial<Player>): Promise<void>;
  setProfile(code: string, id: string, profile: Profile): Promise<void>;
  /**
   * The lobby's settings only. The round's status changes only through the guarded steps below
   * (startRound, beginPlay, endRound, resetForNewRound), so a write a phone buffered while it was
   * offline or asleep can never move a round it no longer sees.
   */
  updateMeta(code: string, patch: Pick<RoomMeta, 'settings'>): Promise<void>;
  /**
   * Saves the final settings, gives every player a fresh set of lives, and begins the countdown, in
   * one atomic step that applies only while the room is in the lobby (a Start tap replayed later
   * cannot restart a round in progress). Resolves to whether this call started the round.
   */
  startRound(code: string, settings: RoomSettings, startAt: number): Promise<boolean>;
  /**
   * The end of the countdown: the round that started at `startAt` begins play, in one atomic step
   * that applies only while that countdown is still on. Every phone may ask (the host first); a call
   * buffered on a phone that was away refuses once the round has ended or the room went back to the
   * lobby. Resolves to whether this call flipped it.
   */
  beginPlay(code: string, startAt: number): Promise<boolean>;
  /**
   * Back to the lobby after the round that started at `startAt` ended, in one atomic step that
   * applies only while that round is still the ended one; otherwise (a tap replayed after another
   * host moved on) it changes nothing. Resolves to whether this call reset the room.
   */
  resetForNewRound(code: string, startAt: number | null): Promise<boolean>;
  /**
   * Applies one shot's hit in a single atomic step over the players map (`evaluatePlayersHit`):
   * refused unless both players are still in the round that started at `roundStartAt`, and applied at
   * most once per `shotId`, which is recorded at players/{target}/shots/{shotId} in the same write. A
   * write the SDK keeps queued after the phone gave up waiting can therefore land only in its own
   * round, and only once. The shield is judged at the time of this call (server clock), however late
   * the write arrives.
   */
  registerHit(code: string, shooter: string, target: string, score: number, via: string, shotId: string, roundStartAt: number | null): Promise<HitOutcome>;
  /**
   * Ends the round in one atomic step: only while it is still playing, with the winner read from the
   * players map in the same step, so twelve phones racing to end the same round agree on one result.
   * `force` is the host's manual end (winner only when exactly one player is alive).
   */
  endRound(code: string, force?: boolean): Promise<EndResult>;
  /**
   * Host migration: when the host's phone has dropped, the earliest-joined connected player becomes
   * host, decided inside one transaction so every phone that notices picks the same person. Returns
   * the new host id, or null when the host is still connected or nobody can take over.
   */
  claimHost(code: string): Promise<string | null>;
  /**
   * Uploads one labelled shot sample (never a photo) under its round. The round's profiles are
   * written once, by whichever phone gets there first; later writes of them are refused and ignored.
   */
  submitShotFeedback(round: string, sample: ShotSample, profiles: ProfilesSnapshot | null): Promise<void>;
  /** Server-synchronised clock in ms. */
  now(): number;
  /** Whether this phone currently has a live link to the room server; the callback fires on every change, and once at subscription. */
  onConnection(cb: (online: boolean) => void): () => void;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export function randomCode(): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

export function pickColor(existing: Record<string, Player> | undefined): string {
  const used = new Set(Object.values(existing ?? {}).map((p) => p.color));
  return PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
}

export function newRoomMeta(code: string, hostId: string, now: number): RoomMeta {
  return { code, hostId, createdAt: now, status: 'lobby', startAt: null, endedAt: null, winnerId: null, settings: DEFAULT_SETTINGS };
}

export function newPlayer(seed: PlayerSeed, color: string, lives: number, now: number): Player {
  return {
    id: seed.id,
    name: seed.name,
    color,
    joinedAt: now,
    connected: true,
    seenAt: now,
    enrolled: false,
    lives,
    status: 'alive',
    lastHitAt: 0,
    eliminatedAt: null,
    tags: 0,
  };
}

/** The per-player fields every round starts from. Shared so both backends reset the same things. */
/** A player's per-round fields at a round start (`round` = its startAt) or a reset to the lobby (`round` null). */
export function roundResetFields(lives: number, round: number | null = null): Pick<Player, 'lives' | 'status' | 'lastHitAt' | 'eliminatedAt' | 'tags' | 'round' | 'shots'> {
  return { lives, status: 'alive', lastHitAt: 0, eliminatedAt: null, tags: 0, round, shots: null };
}

/** The round is over: no player carries it any more, so a hit for it still on its way is refused. */
export function closeRoundPlayers(players: Record<string, Player> | null | undefined): Record<string, Player> {
  const out: Record<string, Player> = {};
  for (const [id, p] of Object.entries(players ?? {})) out[id] = { ...p, round: null };
  return out;
}

/** The meta fields that return to their idle values between rounds. */
export const ROUND_META_RESET: Pick<RoomMeta, 'status' | 'startAt' | 'endedAt' | 'winnerId'> = {
  status: 'lobby',
  startAt: null,
  endedAt: null,
  winnerId: null,
};

/**
 * The preconditions of the round's status steps, each read inside the step's own atomic write: a
 * round starts only from the lobby, plays only from its own countdown, and goes back to the lobby
 * only from its own end. A step a phone buffered while offline re-runs on the room as it is when it
 * arrives, and does nothing unless the room is still where the phone saw it.
 */
export const canStartRound = (meta: Pick<RoomMeta, 'status'> | null | undefined): boolean => meta?.status === 'lobby';
export const canBeginPlay = (meta: Pick<RoomMeta, 'status' | 'startAt'> | null | undefined, startAt: number): boolean =>
  meta?.status === 'countdown' && meta.startAt === startAt;
export const canResetRound = (meta: Pick<RoomMeta, 'status' | 'startAt'> | null | undefined, startAt: number | null): boolean =>
  meta?.status === 'ended' && (meta.startAt ?? null) === startAt;

/** Pure hit resolution for one target. */
export function applyHit(target: Player | null, now: number, invulnMs: number): { outcome: HitOutcome; next?: Player } {
  if (!target) return { outcome: 'invalid' };
  if (target.status !== 'alive') return { outcome: 'dead' };
  if (now - (target.lastHitAt || 0) < invulnMs) return { outcome: 'invulnerable' };
  const lives = target.lives - 1;
  const out = lives <= 0;
  return {
    outcome: out ? 'eliminated' : 'hit',
    next: { ...target, lives, lastHitAt: now, status: out ? 'out' : 'alive', eliminatedAt: out ? now : (target.eliminatedAt ?? null) },
  };
}

export interface HitResult {
  outcome: HitOutcome;
  /** The full players map after the hit, when one was applied. */
  players?: Record<string, Player>;
}

/**
 * Hit resolution over the whole players map. Refuses any hit once the round is already decided (at
 * most one enrolled player alive), which closes the window where a shot fired just before the last
 * elimination would still land after it. The shield is never shorter than MIN_INVULN_MS.
 */
export function evaluateHit(
  players: Record<string, Player> | null,
  shooter: string,
  target: string,
  now: number,
  invulnMs: number | undefined,
): HitResult {
  if (!players) return { outcome: 'invalid' };
  const alive = Object.values(players).filter((p) => p.enrolled && p.status === 'alive');
  if (alive.length <= 1) return { outcome: 'invalid' };
  const r = applyHit(players[target] ?? null, now, shieldMs(invulnMs));
  if (!r.next) return { outcome: r.outcome };
  const next: Record<string, Player> = { ...players, [target]: r.next };
  if (next[shooter]) next[shooter] = { ...next[shooter], tags: (next[shooter].tags ?? 0) + 1 };
  return { outcome: r.outcome, players: next };
}

/**
 * The shield a hit actually uses: the room's setting, never below MIN_INVULN_MS. A room saved with
 * 0 (or by an older build without the field) still costs a target one life per instant, not two.
 */
export function shieldMs(invulnMs: number | undefined): number {
  return typeof invulnMs === 'number' && Number.isFinite(invulnMs) ? Math.max(MIN_INVULN_MS, invulnMs) : MIN_INVULN_MS;
}

export type { HitRecord };

export interface HitRequest {
  shooter: string;
  target: string;
  score: number;
  via: string;
  /** The tap's id. A hit is applied at most once per shot, however often or late it is sent. */
  shotId: string;
  /** meta.startAt of the round the shot was fired in; a hit for any other round is refused. */
  roundStartAt: number | null;
}

/** Shot ids become database keys: letters, digits, '-' and '_' only, so one can never address another path. */
export const isShotId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

/** Whether `meta` is the playing round that started at `roundStartAt`. A shot without a round is never in one. */
export function roundOpenFor(meta: Pick<RoomMeta, 'status' | 'startAt'> | null | undefined, roundStartAt: number | null): boolean {
  return Boolean(meta) && meta!.status === 'playing' && typeof roundStartAt === 'number' && Number.isFinite(roundStartAt) && meta!.startAt === roundStartAt;
}

export interface PlayersHitResult extends HitResult {
  /** The players/{target}/shots/{shotId} entry written with `players`, present exactly when a hit was applied. */
  record?: HitRecord;
}

/** Phones flip to playing on their own clock at startAt (Game.tsx allows 1.5 s); server time may differ this much. */
export const ROUND_START_SKEW_MS = 1500;

/** Whether both players still carry the round the shot was fired in (see Player.round). */
export function inRound(players: Record<string, Player> | null | undefined, req: Pick<HitRequest, 'shooter' | 'target' | 'roundStartAt'>): boolean {
  const r = req.roundStartAt;
  if (typeof r !== 'number' || !Number.isFinite(r)) return false;
  return players?.[req.shooter]?.round === r && players?.[req.target]?.round === r;
}

/**
 * Hit resolution over the players map, so it runs inside one small atomic write with the round check
 * and the shot record (the whole room, profiles included, is hundreds of kB). A shot already in the
 * target's ledger is never applied again and is answered as it landed; a record from another shooter
 * or round is somebody else's shot (an id collision) and refused. Otherwise the hit is refused unless
 * both players are still in the shot's round, then resolved by `evaluateHit` with the round's shield
 * (`invulnMs`, from the room settings, which only change in the lobby).
 *
 * `now` is the shot's own time: the server clock when the phone sent the hit, taken once, never when
 * a re-run or a write queued offline is finally evaluated. Two shooters who tag one target in the
 * same instant then cost it one life, however late the second write reaches the server.
 */
export function evaluatePlayersHit(players: Record<string, Player> | null | undefined, req: HitRequest, now: number, invulnMs: number | undefined): PlayersHitResult {
  if (!isShotId(req.shotId)) return { outcome: 'invalid' };
  const seen = players?.[req.target]?.shots?.[req.shotId];
  if (seen) return { outcome: seen.shooter === req.shooter && seen.target === req.target && seen.round === req.roundStartAt ? seen.outcome : 'invalid' };
  if (!inRound(players, req)) return { outcome: 'invalid' };
  // The countdown is not play: a shot stamped with this round before it began (beyond clock skew) is refused.
  if (now < (req.roundStartAt as number) - ROUND_START_SKEW_MS) return { outcome: 'invalid' };
  const r = evaluateHit(players ?? null, req.shooter, req.target, now, invulnMs);
  if (!r.players || (r.outcome !== 'hit' && r.outcome !== 'eliminated')) return { outcome: r.outcome };
  // The database refuses NaN and undefined; a malformed score or via must not cost the hit.
  const record: HitRecord = {
    shooter: req.shooter,
    target: req.target,
    t: now,
    score: Number.isFinite(req.score) ? req.score : 0,
    via: typeof req.via === 'string' ? req.via : '',
    outcome: r.outcome,
    round: req.roundStartAt as number,
  };
  const t = r.players[req.target];
  return { outcome: r.outcome, players: { ...r.players, [req.target]: { ...t, shots: { ...(t.shots ?? {}), [req.shotId]: record } } }, record };
}

/**
 * A player is present when Firebase still thinks their socket is open AND their heartbeat is
 * recent. Firebase alone takes about a minute to notice a phone that walked out of Wi-Fi range
 * without closing the socket; the heartbeat (NET_CALIB.heartbeatMs) bounds that wait.
 */
export function isPresent(p: Pick<Player, 'connected' | 'seenAt'>, now: number, staleMs = NET_CALIB.presenceStaleMs): boolean {
  if (!p.connected) return false;
  return p.seenAt === undefined || now - p.seenAt <= staleMs;
}

export interface RoundEnd {
  decided: boolean;
  winnerId: string | null;
  /** Decided because every other survivor's phone has dropped off, not because they were shot. */
  forfeit: boolean;
  /** Survivors who are not present (the ones a forfeit is waiting on). */
  absent: Player[];
}

/**
 * A round is decided outright when at most one enrolled player is alive, and by forfeit when at most
 * one of the survivors is still connected. Fewer than two contenders never decide anything (a lobby
 * test round with a lone player ends by hand).
 */
export function decideRoundEnd(players: Record<string, Player> | null | undefined, now: number): RoundEnd {
  const contenders = Object.values(players ?? {}).filter((p) => p.enrolled);
  if (contenders.length < 2) return { decided: false, winnerId: null, forfeit: false, absent: [] };
  const alive = contenders.filter((p) => p.status === 'alive');
  if (alive.length <= 1) return { decided: true, winnerId: alive[0]?.id ?? null, forfeit: false, absent: [] };
  const present = alive.filter((p) => isPresent(p, now));
  const absent = alive.filter((p) => !isPresent(p, now));
  if (present.length <= 1) return { decided: true, winnerId: present[0]?.id ?? null, forfeit: true, absent };
  return { decided: false, winnerId: null, forfeit: false, absent };
}

/** The meta fields that end a playing round, or null when nothing should change. Pure; runs inside a transaction. */
export function endRoundPatch(
  meta: Pick<RoomMeta, 'status'> | null | undefined,
  players: Record<string, Player> | null | undefined,
  now: number,
  force = false,
): Pick<RoomMeta, 'status' | 'endedAt' | 'winnerId'> | null {
  if (!meta || meta.status !== 'playing') return null;
  const end = decideRoundEnd(players, now);
  if (end.decided) return { status: 'ended', endedAt: now, winnerId: end.winnerId };
  if (!force) return null;
  const alive = Object.values(players ?? {}).filter((p) => p.enrolled && p.status === 'alive');
  return { status: 'ended', endedAt: now, winnerId: alive.length === 1 ? alive[0].id : null };
}

/** The earliest-joined connected player, enrolled ones first; null when nobody is connected. */
export function pickNextHost(players: Record<string, Player> | null | undefined, now: number): string | null {
  const connected = Object.values(players ?? {}).filter((p) => isPresent(p, now));
  if (!connected.length) return null;
  connected.sort((a, b) => Number(b.enrolled) - Number(a.enrolled) || a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
  return connected[0].id;
}

/** The new host id when the current host is gone and someone else is connected, else null. Pure; runs inside a transaction. */
export function claimHostPatch(meta: Pick<RoomMeta, 'hostId'> | null | undefined, players: Record<string, Player> | null | undefined, now: number): string | null {
  if (!meta) return null;
  const host = players?.[meta.hostId];
  if (host && isPresent(host, now)) return null;
  const next = pickNextHost(players, now);
  return next && next !== meta.hostId ? next : null;
}
