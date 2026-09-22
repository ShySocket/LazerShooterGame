import type { Player, Profile, Room, RoomMeta, RoomSettings } from '../types';
import { DEFAULT_SETTINGS, PLAYER_COLORS } from '../types';
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
  updateMeta(code: string, patch: Partial<RoomMeta>): Promise<void>;
  /** Saves the final settings, gives every player a fresh set of lives, and begins the countdown. */
  startRound(code: string, settings: RoomSettings, startAt: number): Promise<void>;
  resetForNewRound(code: string): Promise<void>;
  registerHit(code: string, shooter: string, target: string, score: number, via: string): Promise<HitOutcome>;
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
export function roundResetFields(lives: number): Pick<Player, 'lives' | 'status' | 'lastHitAt' | 'eliminatedAt' | 'tags'> {
  return { lives, status: 'alive', lastHitAt: 0, eliminatedAt: null, tags: 0 };
}

/** The meta fields that return to their idle values between rounds. */
export const ROUND_META_RESET: Pick<RoomMeta, 'status' | 'startAt' | 'endedAt' | 'winnerId'> = {
  status: 'lobby',
  startAt: null,
  endedAt: null,
  winnerId: null,
};

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
 * Hit resolution over the whole players map, so it can run inside one atomic write. Refuses any hit
 * once the round is already decided (at most one enrolled player alive), which closes the window
 * where a shot fired just before the last elimination would still land after it.
 */
export function evaluateHit(
  players: Record<string, Player> | null,
  shooter: string,
  target: string,
  now: number,
  invulnMs: number,
): HitResult {
  if (!players) return { outcome: 'invalid' };
  const alive = Object.values(players).filter((p) => p.enrolled && p.status === 'alive');
  if (alive.length <= 1) return { outcome: 'invalid' };
  const r = applyHit(players[target] ?? null, now, invulnMs);
  if (!r.next) return { outcome: r.outcome };
  const next: Record<string, Player> = { ...players, [target]: r.next };
  if (next[shooter]) next[shooter] = { ...next[shooter], tags: (next[shooter].tags ?? 0) + 1 };
  return { outcome: r.outcome, players: next };
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
