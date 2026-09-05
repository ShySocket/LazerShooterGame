import type { Player, Profile, Room, RoomMeta } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { applyHit, newPlayer, pickColor, randomCode, type HitOutcome, type PlayerSeed, type RoomBackend } from './backend';

/** In-memory backend used when no Firebase config is present. Single device only. */
export class LocalBackend implements RoomBackend {
  readonly mode = 'local' as const;
  private rooms = new Map<string, Room>();
  private subs = new Map<string, Set<(room: Room | null) => void>>();

  now(): number {
    return Date.now();
  }

  private emit(code: string): void {
    const room = this.rooms.get(code) ?? null;
    this.subs.get(code)?.forEach((cb) => cb(room ? structuredClone(room) : null));
  }

  async createRoom(host: PlayerSeed): Promise<string> {
    const code = randomCode();
    const meta: RoomMeta = {
      code,
      hostId: host.id,
      createdAt: this.now(),
      status: 'lobby',
      startAt: null,
      endedAt: null,
      winnerId: null,
      settings: DEFAULT_SETTINGS,
    };
    this.rooms.set(code, {
      ...meta,
      players: { [host.id]: newPlayer(host, pickColor(undefined), DEFAULT_SETTINGS.lives, this.now()) },
      profiles: {},
    });
    this.emit(code);
    return code;
  }

  async joinRoom(code: string, player: PlayerSeed): Promise<boolean> {
    const room = this.rooms.get(code);
    if (!room) return false;
    const existing = room.players[player.id];
    if (existing) {
      existing.connected = true;
      existing.name = player.name;
    } else {
      room.players[player.id] = newPlayer(player, pickColor(room.players), room.settings.lives, this.now());
    }
    this.emit(code);
    return true;
  }

  subscribe(code: string, cb: (room: Room | null) => void): () => void {
    if (!this.subs.has(code)) this.subs.set(code, new Set());
    this.subs.get(code)!.add(cb);
    const room = this.rooms.get(code) ?? null;
    queueMicrotask(() => cb(room ? structuredClone(room) : null));
    return () => this.subs.get(code)?.delete(cb);
  }

  async updatePlayer(code: string, id: string, patch: Partial<Player>): Promise<void> {
    const room = this.rooms.get(code);
    if (!room?.players[id]) return;
    Object.assign(room.players[id], patch);
    this.emit(code);
  }

  async setProfile(code: string, id: string, profile: Profile): Promise<void> {
    const room = this.rooms.get(code);
    if (!room) return;
    room.profiles[id] = profile;
    if (room.players[id]) room.players[id].enrolled = true;
    this.emit(code);
  }

  async updateMeta(code: string, patch: Partial<RoomMeta>): Promise<void> {
    const room = this.rooms.get(code);
    if (!room) return;
    Object.assign(room, patch);
    this.emit(code);
  }

  async resetForNewRound(code: string): Promise<void> {
    const room = this.rooms.get(code);
    if (!room) return;
    room.status = 'lobby';
    room.startAt = null;
    room.endedAt = null;
    room.winnerId = null;
    for (const p of Object.values(room.players)) {
      p.lives = room.settings.lives;
      p.status = 'alive';
      p.lastHitAt = 0;
      p.eliminatedAt = null;
      p.tags = 0;
    }
    this.emit(code);
  }

  async registerHit(code: string, shooter: string, target: string): Promise<HitOutcome> {
    const room = this.rooms.get(code);
    if (!room || room.status !== 'playing') return 'invalid';
    const r = applyHit(room.players[target] ?? null, this.now(), room.settings.invulnMs);
    if (r.next) {
      room.players[target] = r.next;
      if (room.players[shooter]) room.players[shooter].tags += 1;
      this.emit(code);
    }
    return r.outcome;
  }
}
