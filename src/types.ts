export type PlayerStatus = 'alive' | 'out';
export type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'ended';

/** Torso colour histograms captured at enrollment, front and back. */
export interface TorsoSig {
  front: number[];
  back: number[];
}

/** What the shooter's phone needs to recognise a player. Never contains photos. */
export interface Profile {
  face: number[][];
  torso: TorsoSig;
}

export interface Player {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  connected: boolean;
  enrolled: boolean;
  lives: number;
  status: PlayerStatus;
  lastHitAt: number;
  eliminatedAt?: number | null;
  tags: number;
}

export interface RoomSettings {
  lives: number;
  cooldownMs: number;
  invulnMs: number;
  /** Minimum belief for the top candidate before a hit counts. */
  hitThreshold: number;
  /** Minimum gap between top and runner-up belief. */
  hitMargin: number;
}

export interface RoomMeta {
  code: string;
  hostId: string;
  createdAt: number;
  status: RoomStatus;
  startAt?: number | null;
  endedAt?: number | null;
  winnerId?: string | null;
  settings: RoomSettings;
}

export interface Room extends RoomMeta {
  players: Record<string, Player>;
  profiles: Record<string, Profile>;
}

export interface HitEvent {
  shooter: string;
  target: string;
  t: number;
  score: number;
  via: string;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  lives: 3,
  cooldownMs: 1000,
  invulnMs: 3000,
  hitThreshold: 0.5,
  hitMargin: 0.2,
};

export const PLAYER_COLORS = ['#ff3b5c', '#3bd1ff', '#ffd23b', '#7cff3b', '#c43bff', '#ff8a3b'];

/** Two torso signatures above this are too similar to tell apart. */
export const CLOTHING_CONFLICT = 0.72;
