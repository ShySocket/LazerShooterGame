export type PlayerStatus = 'alive' | 'out';
export type RoomStatus = 'lobby' | 'countdown' | 'playing' | 'ended';

/** Colour histograms of the visible clothing regions from one side. Missing regions were not in frame. */
export interface OutfitSig {
  top: number[];
  thighs?: number[];
  shins?: number[];
  hair?: number[];
}

/** Outfit captured at enrollment, front and back. */
export interface OutfitSides {
  front: OutfitSig;
  back: OutfitSig;
}

/** Scale-free body ratios from the pose model. Weak identity signal, stable across games. */
export interface BodyProps {
  /** Shoulder width / torso length. */
  shoulderTorso: number;
  /** Hip width / shoulder width. */
  hipShoulder: number;
  /** Leg length (hip to ankle) / torso length. */
  legTorso: number;
  /** Head width (ear to ear) / shoulder width. */
  headShoulder: number;
}

/** One-time scan stored under a signed-in account: the parts of a person that do not change between games. */
export interface DeepProfile {
  faceModel: string;
  face: number[][];
  body: BodyProps | null;
  bodyModel?: string;
  updatedAt: number;
}

/** Public account record. Never contains photos. */
export interface UserRecord {
  name: string;
  deep?: DeepProfile | null;
}

/** What the shooter's phone needs to recognise a player. Never contains photos. */
export interface Profile {
  /** Which face descriptor produced the embeddings, so mismatched profiles are ignored rather than misread. */
  faceModel: string;
  face: number[][];
  /** Head angle and how each scan sample was taken (the selfie samples, in order); absent on older scans. */
  faceMeta?: { yaw: number; pitch: number; how: string }[];
  outfit: OutfitSides;
  body?: BodyProps | null;
  bodyModel?: string;
}

/** Body ratios measured in pixels, independent of the camera's aspect ratio. */
export const BODY_MODEL = 'movenet-multipose-pixel-v1';

export interface Player {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  connected: boolean;
  /** Last heartbeat from this phone (server clock). Older than NET_CALIB.presenceStaleMs counts as gone. */
  seenAt?: number;
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

export const DEFAULT_SETTINGS: RoomSettings = {
  lives: 3,
  cooldownMs: 1000,
  invulnMs: 3000,
  hitThreshold: 0.5,
  hitMargin: 0.2,
};

/** Twelve colours that stay apart on a phone screen; a thirteenth player gets a random repeat. */
export const PLAYER_COLORS = [
  '#ff3b5c', '#3bd1ff', '#ffd23b', '#7cff3b', '#c43bff', '#ff8a3b',
  '#ff3bd4', '#3bffc8', '#3b6bff', '#f5f5f5', '#d9a066', '#9aa4b2',
];

/** Two outfits above this are too similar to tell apart. */
export const CLOTHING_CONFLICT = 0.72;

/** Pseudo-candidate id for "nobody in this room". */
export const UNKNOWN_ID = '_unknown';

/** Players taking part in the round: enrolled with a profile in this room. */
export function enrolledPlayers(room: Pick<Room, 'players'>): Player[] {
  return Object.values(room.players).filter((p) => p.enrolled);
}

export function alivePlayers(room: Pick<Room, 'players'>): Player[] {
  return enrolledPlayers(room).filter((p) => p.status === 'alive');
}

export function livesLabel(p: Player): string {
  return p.status === 'alive' ? `${p.lives} ♥` : 'out';
}
