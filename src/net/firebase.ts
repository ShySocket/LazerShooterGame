import {
  getDatabase,
  ref,
  set,
  update,
  get,
  onValue,
  onDisconnect,
  runTransaction,
  push,
  type Database,
  type DatabaseReference,
} from 'firebase/database';
import type { Player, Profile, Room, RoomMeta, RoomSettings } from '../types';
import {
  claimHostPatch,
  endRoundPatch,
  evaluateHit,
  newPlayer,
  newRoomMeta,
  pickColor,
  randomCode,
  ROUND_META_RESET,
  roundResetFields,
  type EndResult,
  type HitOutcome,
  type JoinResult,
  type PlayerSeed,
  type RoomBackend,
} from './backend';
import { firebaseApp } from './firebaseApp';
import { NET_CALIB } from '../vision/calibration';
import type { ProfilesSnapshot, ShotSample } from '../feedback/sample';

export { hasFirebaseConfig } from './firebaseApp';

interface Presence {
  connectedRef: DatabaseReference;
  unsubscribe: () => void;
  heartbeat: ReturnType<typeof setInterval>;
}

/**
 * The slice of the Realtime Database SDK this backend uses, as free functions taking a database or a
 * reference. Tests inject an in-memory implementation (tests/net/fakeDb.ts); the app uses the SDK.
 */
export interface DbSdk {
  ref: typeof ref;
  get: typeof get;
  set: typeof set;
  update: typeof update;
  onValue: typeof onValue;
  onDisconnect: typeof onDisconnect;
  runTransaction: typeof runTransaction;
  push: typeof push;
}

export const REAL_SDK: DbSdk = { ref, get, set, update, onValue, onDisconnect, runTransaction, push };

export class FirebaseBackend implements RoomBackend {
  readonly mode = 'firebase' as const;
  private db: Database;
  private offset = 0;
  /** Latest meta seen by an active subscription, so hits do not need a read round trip first. */
  private metaCache = new Map<string, RoomMeta | null>();
  private presence = new Map<string, Presence>();

  constructor(private sdk: DbSdk = REAL_SDK, db?: Database) {
    this.db = db ?? getDatabase(firebaseApp());
    this.sdk.onValue(this.sdk.ref(this.db, '.info/serverTimeOffset'), (s) => {
      this.offset = (s.val() as number | null) ?? 0;
    });
  }

  now(): number {
    return Date.now() + this.offset;
  }

  onConnection(cb: (online: boolean) => void): () => void {
    return this.sdk.onValue(this.sdk.ref(this.db, '.info/connected'), (s) => cb(s.val() === true));
  }

  private path(code: string, sub = ''): string {
    return `rooms/${code}${sub ? '/' + sub : ''}`;
  }

  async createRoom(host: PlayerSeed): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const exists = await this.sdk.get(this.sdk.ref(this.db, this.path(code, 'meta')));
      if (exists.exists()) continue;
      const meta = newRoomMeta(code, host.id, this.now());
      await this.sdk.set(this.sdk.ref(this.db, this.path(code)), {
        meta,
        players: { [host.id]: newPlayer(host, pickColor(undefined), meta.settings.lives, this.now()) },
      });
      this.attachPresence(code, host.id);
      return code;
    }
    throw new Error('Could not allocate a room code, try again');
  }

  async joinRoom(code: string, player: PlayerSeed): Promise<JoinResult> {
    const metaSnap = await this.sdk.get(this.sdk.ref(this.db, this.path(code, 'meta')));
    const meta = metaSnap.val() as RoomMeta | null;
    if (!meta) return 'missing';
    const now = this.now();
    // One transaction over the players map so two simultaneous joiners cannot pick the same colour,
    // and so a newcomer is turned away while a round is in progress (returning players may rejoin).
    const res = await this.sdk.runTransaction(
      this.sdk.ref(this.db, this.path(code, 'players')),
      (players: Record<string, Player> | null) => {
        // A fresh page has no local copy of the players map and is handed null first. Writing the
        // player in optimistically makes the server reject the write (the room has players) and
        // re-run this function on the real map; aborting here instead would turn a returning
        // player away from a round in progress.
        if (players === null) return { [player.id]: newPlayer(player, pickColor(undefined), meta.settings.lives, now) };
        const map = players;
        if (map[player.id]) return { ...map, [player.id]: { ...map[player.id], connected: true, name: player.name } };
        if (meta.status !== 'lobby') return; // abort: newcomers wait for the lobby
        return { ...map, [player.id]: newPlayer(player, pickColor(map), meta.settings.lives, now) };
      },
      { applyLocally: false },
    );
    // The outcome is read from the committed snapshot, never from a closure the transaction may re-run.
    const after = (res.snapshot.val() as Record<string, Player> | null) ?? {};
    const result: JoinResult = after[player.id] ? 'ok' : 'in-progress';
    if (result === 'ok') this.attachPresence(code, player.id);
    return result;
  }

  /**
   * Presence follows the socket: every time the client connects (including after a Wi-Fi drop) it
   * re-arms the disconnect hook and writes connected=true again.
   */
  private attachPresence(code: string, id: string): void {
    const key = `${code}/${id}`;
    this.presence.get(key)?.unsubscribe();
    const connectedRef = this.sdk.ref(this.db, this.path(code, `players/${id}/connected`));
    const seenRef = this.sdk.ref(this.db, this.path(code, `players/${id}/seenAt`));
    const beat = () => void this.sdk.set(seenRef, this.now()).catch(() => undefined);
    const unsubscribe = this.sdk.onValue(this.sdk.ref(this.db, '.info/connected'), (s) => {
      if (s.val() !== true) return;
      void this.sdk.onDisconnect(connectedRef)
        .set(false)
        .then(() => this.sdk.set(connectedRef, true))
        .then(beat);
    });
    // The heartbeat bounds how long a phone that silently lost Wi-Fi keeps counting as present.
    // Only while the page is visible: a backgrounded phone is not playing.
    const heartbeat = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') beat();
    }, NET_CALIB.heartbeatMs);
    (heartbeat as { unref?: () => void }).unref?.();
    this.presence.set(key, { connectedRef, unsubscribe, heartbeat });
  }

  async leaveRoom(code: string, id: string): Promise<void> {
    const key = `${code}/${id}`;
    const p = this.presence.get(key);
    this.presence.delete(key);
    p?.unsubscribe();
    if (p) clearInterval(p.heartbeat);
    const connectedRef = p?.connectedRef ?? this.sdk.ref(this.db, this.path(code, `players/${id}/connected`));
    await this.sdk.onDisconnect(connectedRef).cancel();
    await this.sdk.set(connectedRef, false);
  }

  subscribe(code: string, cb: (room: Room | null) => void): () => void {
    let meta: RoomMeta | null = null;
    let players: Record<string, Player> = {};
    let profiles: Record<string, Profile> = {};
    const got = { meta: false, players: false, profiles: false };
    // Wait for every part before the first emit, otherwise the UI sees a room with nobody in it.
    const emit = () => {
      if (!got.meta) return;
      if (meta && (!got.players || !got.profiles)) return;
      cb(meta ? { ...meta, players, profiles } : null);
    };
    const u1 = this.sdk.onValue(this.sdk.ref(this.db, this.path(code, 'meta')), (s) => {
      meta = s.val() as RoomMeta | null;
      this.metaCache.set(code, meta);
      got.meta = true;
      emit();
    });
    const u2 = this.sdk.onValue(this.sdk.ref(this.db, this.path(code, 'players')), (s) => {
      players = (s.val() as Record<string, Player> | null) ?? {};
      got.players = true;
      emit();
    });
    const u3 = this.sdk.onValue(this.sdk.ref(this.db, this.path(code, 'profiles')), (s) => {
      profiles = (s.val() as Record<string, Profile> | null) ?? {};
      got.profiles = true;
      emit();
    });
    return () => {
      u1();
      u2();
      u3();
      this.metaCache.delete(code);
    };
  }

  async updatePlayer(code: string, id: string, patch: Partial<Player>): Promise<void> {
    await this.sdk.update(this.sdk.ref(this.db, this.path(code, `players/${id}`)), stripUndefined(patch));
  }

  async setProfile(code: string, id: string, profile: Profile): Promise<void> {
    await this.sdk.set(this.sdk.ref(this.db, this.path(code, `profiles/${id}`)), profile);
    await this.updatePlayer(code, id, { enrolled: true });
  }

  async updateMeta(code: string, patch: Partial<RoomMeta>): Promise<void> {
    await this.sdk.update(this.sdk.ref(this.db, this.path(code, 'meta')), stripUndefined(patch));
  }

  private resetPlayers(players: Record<string, Player> | null | undefined, lives: number): Record<string, Player> {
    const out: Record<string, Player> = {};
    for (const [id, p] of Object.entries(players ?? {})) out[id] = { ...p, ...roundResetFields(lives) };
    return out;
  }

  /**
   * One transaction over the whole rooms/{code} node. A client that has never read the whole room
   * (screens subscribe to its children) is handed null on the first attempt; returning that value
   * unchanged, never undefined (which would abort), makes the server reject the write and re-run
   * `fn` on the real room. No local optimistic apply, so the UI never sees a half-built room.
   */
  private roomTransaction(code: string, fn: (room: RoomNode) => RoomNode | undefined) {
    return this.sdk.runTransaction(
      this.sdk.ref(this.db, this.path(code)),
      (room: RoomNode | null) => (room?.meta ? fn(room) : (room ?? null)),
      { applyLocally: false },
    );
  }

  /** One transaction over the whole room, so a player joining mid-write cannot keep stale lives. */
  async startRound(code: string, settings: RoomSettings, startAt: number): Promise<void> {
    await this.roomTransaction(code, (room) => {
      if (!room.meta) return; // abort
      const { events: _events, ...rest } = room;
      return {
        ...rest,
        players: this.resetPlayers(room.players, settings.lives),
        meta: { ...room.meta, settings, status: 'countdown', startAt, endedAt: null, winnerId: null },
      };
    });
  }

  async resetForNewRound(code: string): Promise<void> {
    await this.roomTransaction(code, (room) => {
      if (!room.meta) return; // abort
      const { events: _events, ...rest } = room;
      return { ...rest, players: this.resetPlayers(room.players, room.meta.settings.lives), meta: { ...room.meta, ...ROUND_META_RESET } };
    });
  }

  async endRound(code: string, force = false): Promise<EndResult> {
    const now = this.now();
    let result: EndResult = 'already';
    const res = await this.roomTransaction(code, (room) => {
      const patch = endRoundPatch(room.meta, room.players, now, force);
      result = !room.meta || room.meta.status !== 'playing' ? 'already' : patch ? 'ended' : 'not-decided';
      if (!patch || !room.meta) return; // abort
      return { ...room, meta: { ...room.meta, ...patch } };
    });
    return res.committed ? 'ended' : result;
  }

  async claimHost(code: string): Promise<string | null> {
    let next: string | null = null;
    const res = await this.roomTransaction(code, (room) => {
      next = claimHostPatch(room.meta, room.players, this.now());
      if (!next || !room.meta) return; // abort
      return { ...room, meta: { ...room.meta, hostId: next } };
    });
    return res.committed ? next : null;
  }

  async registerHit(code: string, shooter: string, target: string, score: number, via: string): Promise<HitOutcome> {
    let meta = this.metaCache.get(code);
    if (meta === undefined) meta = (await this.sdk.get(this.sdk.ref(this.db, this.path(code, 'meta')))).val() as RoomMeta | null;
    if (!meta || meta.status !== 'playing') return 'invalid';
    const now = this.now();
    const invulnMs = meta.settings.invulnMs;
    const state = { outcome: 'invalid' as HitOutcome };
    const res = await this.sdk.runTransaction(
      this.sdk.ref(this.db, this.path(code, 'players')),
      (players: Record<string, Player> | null) => {
        // No local copy of the players map yet (a phone that has not subscribed): hand the null back
        // so the server rejects the write and re-runs this on the real map, instead of aborting.
        if (players === null) return null;
        const r = evaluateHit(players, shooter, target, now, invulnMs);
        state.outcome = r.outcome;
        return r.players; // undefined aborts the transaction
      },
      { applyLocally: false },
    );
    const outcome = state.outcome;
    if (res.committed && (outcome === 'hit' || outcome === 'eliminated')) {
      void this.sdk.push(this.sdk.ref(this.db, this.path(code, 'events')), { shooter, target, t: now, score, via });
    }
    return outcome;
  }

  async submitShotFeedback(round: string, sample: ShotSample, profiles: ProfilesSnapshot | null): Promise<void> {
    const base = `feedback/rounds/${round}`;
    if (profiles) {
      // Write-once by rule: the phone that lost the race gets a permission error, which is the
      // expected outcome, not a failure of this upload.
      await this.sdk.set(this.sdk.ref(this.db, `${base}/profiles`), jsonClean(profiles)).catch((e: unknown) => {
        if (!/permission/i.test(String((e as { code?: string }).code ?? e))) throw e;
      });
    }
    // Keyed by the shot id (write-once by rule), so a retry after a timed-out upload cannot store the
    // sample twice; the refused retry is dropped by the queue after a few attempts.
    await this.sdk.set(this.sdk.ref(this.db, `${base}/samples/${sample.shot.id}`), jsonClean(sample));
  }
}

/** The shape of rooms/{code} as one node. */
interface RoomNode {
  meta?: RoomMeta;
  players?: Record<string, Player>;
  profiles?: Record<string, Profile>;
  events?: unknown;
}

/** The database refuses undefined and non-finite numbers; a JSON round trip turns them into nulls. */
function jsonClean<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}
