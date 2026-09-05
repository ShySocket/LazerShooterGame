import type { Player, Profile, Room, RoomMeta } from '../types';
import { PLAYER_COLORS } from '../types';

export type HitOutcome = 'hit' | 'eliminated' | 'invulnerable' | 'dead' | 'invalid';
export type PlayerSeed = Pick<Player, 'id' | 'name'>;

export interface RoomBackend {
  readonly mode: 'firebase' | 'local';
  createRoom(host: PlayerSeed): Promise<string>;
  /** Resolves false when the room does not exist. */
  joinRoom(code: string, player: PlayerSeed): Promise<boolean>;
  subscribe(code: string, cb: (room: Room | null) => void): () => void;
  updatePlayer(code: string, id: string, patch: Partial<Player>): Promise<void>;
  setProfile(code: string, id: string, profile: Profile): Promise<void>;
  updateMeta(code: string, patch: Partial<RoomMeta>): Promise<void>;
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

/** Pure hit resolution shared by both backends so the rules live in one place. */
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
