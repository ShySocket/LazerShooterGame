import type { Player, Profile, Room, RoomMeta, RoomSettings } from '../types';
import {
  canBeginPlay,
  canResetRound,
  canStartRound,
  claimHostPatch,
  closeRoundPlayers,
  endRoundPatch,
  evaluatePlayersHit,
  newPlayer,
  newRoomMeta,
  pickColor,
  randomCode,
  ROUND_META_RESET,
  roundOpenFor,
  roundResetFields,
  type EndResult,
  type HitOutcome,
  type JoinResult,
  type PlayerSeed,
  type RoomBackend,
} from './backend';
import type { ProfilesSnapshot, ShotSample } from '../feedback/sample';

/** In-memory backend used when no Firebase config is present. Single device only. */
export class LocalBackend implements RoomBackend {
  readonly mode = 'local' as const;
  private rooms = new Map<string, Room>();
  private subs = new Map<string, Set<(room: Room | null) => void>>();

  now(): number {
    return Date.now();
  }

  onConnection(cb: (online: boolean) => void): () => void {
    cb(true);
    return () => undefined;
  }

  private emit(code: string): void {
    const room = this.rooms.get(code) ?? null;
    this.subs.get(code)?.forEach((cb) => cb(room ? structuredClone(room) : null));
  }

  async createRoom(host: PlayerSeed): Promise<string> {
    const code = randomCode();
    const meta = newRoomMeta(code, host.id, this.now());
    this.rooms.set(code, {
      ...meta,
      players: { [host.id]: newPlayer(host, pickColor(undefined), meta.settings.lives, this.now()) },
      profiles: {},
    });
    this.emit(code);
    return code;
  }

  async joinRoom(code: string, player: PlayerSeed): Promise<JoinResult> {
    const room = this.rooms.get(code);
    if (!room) return 'missing';
    const existing = room.players[player.id];
    if (existing) {
      existing.connected = true;
      existing.name = player.name;
    } else {
      if (room.status !== 'lobby') return 'in-progress';
      room.players[player.id] = newPlayer(player, pickColor(room.players), room.settings.lives, this.now());
    }
    this.emit(code);
    return 'ok';
  }

  async leaveRoom(code: string, id: string): Promise<void> {
    await this.updatePlayer(code, id, { connected: false });
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

  async updateMeta(code: string, patch: Pick<RoomMeta, 'settings'>): Promise<void> {
    const room = this.rooms.get(code);
    if (!room) return;
    Object.assign(room, patch);
    this.emit(code);
  }

  private resetPlayers(room: Room, lives: number, round: number | null = null): void {
    for (const p of Object.values(room.players)) Object.assign(p, roundResetFields(lives, round));
  }

  /** The status steps keep the Firebase room's preconditions (`canStartRound`, `canBeginPlay`, `canResetRound`). */
  async startRound(code: string, settings: RoomSettings, startAt: number): Promise<boolean> {
    const room = this.rooms.get(code);
    if (!room || !canStartRound(room)) return false;
    room.settings = settings;
    this.resetPlayers(room, settings.lives, startAt);
    Object.assign(room, { status: 'countdown', startAt, endedAt: null, winnerId: null });
    this.emit(code);
    return true;
  }

  async beginPlay(code: string, startAt: number): Promise<boolean> {
    const room = this.rooms.get(code);
    if (!room || !canBeginPlay(room, startAt)) return false;
    room.status = 'playing';
    this.emit(code);
    return true;
  }

  async resetForNewRound(code: string, startAt: number | null): Promise<boolean> {
    const room = this.rooms.get(code);
    if (!room || !canResetRound(room, startAt)) return false;
    Object.assign(room, ROUND_META_RESET);
    this.resetPlayers(room, room.settings.lives);
    this.emit(code);
    return true;
  }

  /** The same rule as the Firebase room (`evaluatePlayersHit`); one thread, so the read and the write cannot interleave. */
  async registerHit(code: string, shooter: string, target: string, score: number, via: string, shotId: string, roundStartAt: number | null): Promise<HitOutcome> {
    const room = this.rooms.get(code);
    if (!room || !roundOpenFor(room, roundStartAt)) return 'invalid';
    const r = evaluatePlayersHit(room.players, { shooter, target, score, via, shotId, roundStartAt }, this.now(), room.settings.invulnMs);
    if (r.players && r.record) {
      room.players = r.players;
      this.emit(code);
    }
    return r.outcome;
  }

  async endRound(code: string, force = false): Promise<EndResult> {
    const room = this.rooms.get(code);
    if (!room || room.status !== 'playing') return 'already';
    const patch = endRoundPatch(room, room.players, this.now(), force);
    if (!patch) return 'not-decided';
    Object.assign(room, patch);
    room.players = closeRoundPlayers(room.players);
    this.emit(code);
    return 'ended';
  }

  async claimHost(code: string): Promise<string | null> {
    const room = this.rooms.get(code);
    const next = claimHostPatch(room, room?.players, this.now());
    if (!room || !next) return null;
    room.hostId = next;
    this.emit(code);
    return next;
  }

  /** Labelled samples stay in memory; a dev build exposes them on window.__lz.feedback. */
  readonly feedback: { round: string; sample: ShotSample; profiles: ProfilesSnapshot | null }[] = [];

  async submitShotFeedback(round: string, sample: ShotSample, profiles: ProfilesSnapshot | null): Promise<void> {
    this.feedback.push({ round, sample, profiles: this.feedback.some((f) => f.round === round) ? null : profiles });
  }
}
