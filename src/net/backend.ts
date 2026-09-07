import type { Player, Profile, Room, RoomMeta, RoomSettings } from '../types';
import { DEFAULT_SETTINGS, PLAYER_COLORS } from '../types';

export type HitOutcome = 'hit' | 'eliminated' | 'invulnerable' | 'dead' | 'invalid';
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
  /** Server-synchronised clock in ms. */
  now(): number;
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
