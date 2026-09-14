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
  evaluateHit,
  newPlayer,
  newRoomMeta,
  pickColor,
  randomCode,
  ROUND_META_RESET,
  roundResetFields,
  type HitOutcome,
  type JoinResult,
  type PlayerSeed,
  type RoomBackend,
} from './backend';
import { firebaseApp } from './firebaseApp';
import type { ProfilesSnapshot, ShotSample } from '../feedback/sample';

export { hasFirebaseConfig } from './firebaseApp';

interface Presence {
  connectedRef: DatabaseReference;
  unsubscribe: () => void;
}

export class FirebaseBackend implements RoomBackend {
  readonly mode = 'firebase' as const;
  private db: Database;
  private offset = 0;
  /** Latest meta seen by an active subscription, so hits do not need a read round trip first. */
  private metaCache = new Map<string, RoomMeta | null>();
  private presence = new Map<string, Presence>();

  constructor() {
    this.db = getDatabase(firebaseApp());
    onValue(ref(this.db, '.info/serverTimeOffset'), (s) => {
      this.offset = (s.val() as number | null) ?? 0;
    });
  }

  now(): number {
    return Date.now() + this.offset;
  }

  private path(code: string, sub = ''): string {
    return `rooms/${code}${sub ? '/' + sub : ''}`;
  }

  async createRoom(host: PlayerSeed): Promise<string> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = randomCode();
      const exists = await get(ref(this.db, this.path(code, 'meta')));
      if (exists.exists()) continue;
      const meta = newRoomMeta(code, host.id, this.now());
      await set(ref(this.db, this.path(code)), {
        meta,
        players: { [host.id]: newPlayer(host, pickColor(undefined), meta.settings.lives, this.now()) },
      });
      this.attachPresence(code, host.id);
      return code;
    }
    throw new Error('Could not allocate a room code, try again');
  }

  async joinRoom(code: string, player: PlayerSeed): Promise<JoinResult> {
    const metaSnap = await get(ref(this.db, this.path(code, 'meta')));
    const meta = metaSnap.val() as RoomMeta | null;
    if (!meta) return 'missing';
    const now = this.now();
    // One transaction over the players map so two simultaneous joiners cannot pick the same colour,
    // and so a newcomer is turned away while a round is in progress (returning players may rejoin).
    let result: JoinResult = 'ok';
    await runTransaction(ref(this.db, this.path(code, 'players')), (players: Record<string, Player> | null) => {
      const map = players ?? {};
      if (map[player.id]) {
        result = 'ok';
        return { ...map, [player.id]: { ...map[player.id], connected: true, name: player.name } };
      }
      if (meta.status !== 'lobby') {
        result = 'in-progress';
        return; // abort
      }
      result = 'ok';
      return { ...map, [player.id]: newPlayer(player, pickColor(map), meta.settings.lives, now) };
    });
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
    const connectedRef = ref(this.db, this.path(code, `players/${id}/connected`));
    const unsubscribe = onValue(ref(this.db, '.info/connected'), (s) => {
      if (s.val() !== true) return;
      void onDisconnect(connectedRef)
        .set(false)
        .then(() => set(connectedRef, true));
    });
    this.presence.set(key, { connectedRef, unsubscribe });
  }

  async leaveRoom(code: string, id: string): Promise<void> {
    const key = `${code}/${id}`;
    const p = this.presence.get(key);
    this.presence.delete(key);
    p?.unsubscribe();
    const connectedRef = p?.connectedRef ?? ref(this.db, this.path(code, `players/${id}/connected`));
    await onDisconnect(connectedRef).cancel();
    await set(connectedRef, false);
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
    const u1 = onValue(ref(this.db, this.path(code, 'meta')), (s) => {
      meta = s.val() as RoomMeta | null;
      this.metaCache.set(code, meta);
      got.meta = true;
      emit();
    });
    const u2 = onValue(ref(this.db, this.path(code, 'players')), (s) => {
      players = (s.val() as Record<string, Player> | null) ?? {};
      got.players = true;
      emit();
    });
    const u3 = onValue(ref(this.db, this.path(code, 'profiles')), (s) => {
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
    await update(ref(this.db, this.path(code, `players/${id}`)), stripUndefined(patch));
  }

  async setProfile(code: string, id: string, profile: Profile): Promise<void> {
    await set(ref(this.db, this.path(code, `profiles/${id}`)), profile);
    await this.updatePlayer(code, id, { enrolled: true });
  }

  async updateMeta(code: string, patch: Partial<RoomMeta>): Promise<void> {
    await update(ref(this.db, this.path(code, 'meta')), stripUndefined(patch));
  }

  private async playerIds(code: string): Promise<string[]> {
    const snap = await get(ref(this.db, this.path(code, 'players')));
    return Object.keys((snap.val() as Record<string, Player> | null) ?? {});
  }

  private resetPatch(ids: string[], lives: number): Record<string, unknown> {
    const patch: Record<string, unknown> = { events: null };
    for (const id of ids) {
      for (const [k, v] of Object.entries(roundResetFields(lives))) patch[`players/${id}/${k}`] = v;
    }
    return patch;
  }

  async startRound(code: string, settings: RoomSettings, startAt: number): Promise<void> {
    const ids = await this.playerIds(code);
    await update(ref(this.db, this.path(code)), {
      ...this.resetPatch(ids, settings.lives),
      'meta/settings': settings,
      'meta/status': 'countdown',
      'meta/startAt': startAt,
      'meta/endedAt': null,
      'meta/winnerId': null,
    });
  }

  async resetForNewRound(code: string): Promise<void> {
    const meta = this.metaCache.get(code) ?? ((await get(ref(this.db, this.path(code, 'meta')))).val() as RoomMeta | null);
    if (!meta) return;
    const ids = await this.playerIds(code);
    const patch = this.resetPatch(ids, meta.settings.lives);
    for (const [k, v] of Object.entries(ROUND_META_RESET)) patch[`meta/${k}`] = v;
    await update(ref(this.db, this.path(code)), patch);
  }

  async registerHit(code: string, shooter: string, target: string, score: number, via: string): Promise<HitOutcome> {
    let meta = this.metaCache.get(code);
    if (meta === undefined) meta = (await get(ref(this.db, this.path(code, 'meta')))).val() as RoomMeta | null;
    if (!meta || meta.status !== 'playing') return 'invalid';
    const now = this.now();
    const invulnMs = meta.settings.invulnMs;
    const state = { outcome: 'invalid' as HitOutcome };
    const res = await runTransaction(ref(this.db, this.path(code, 'players')), (players: Record<string, Player> | null) => {
      const r = evaluateHit(players, shooter, target, now, invulnMs);
      state.outcome = r.outcome;
      return r.players; // undefined aborts the transaction
    });
    const outcome = state.outcome;
    if (res.committed && (outcome === 'hit' || outcome === 'eliminated')) {
      void push(ref(this.db, this.path(code, 'events')), { shooter, target, t: now, score, via });
    }
    return outcome;
  }

  async submitShotFeedback(round: string, sample: ShotSample, profiles: ProfilesSnapshot | null): Promise<void> {
    const base = `feedback/rounds/${round}`;
    if (profiles) {
      // Write-once by rule: the phone that lost the race gets a permission error, which is the
      // expected outcome, not a failure of this upload.
      await set(ref(this.db, `${base}/profiles`), jsonClean(profiles)).catch((e: unknown) => {
        if (!/permission/i.test(String((e as { code?: string }).code ?? e))) throw e;
      });
    }
    await push(ref(this.db, `${base}/samples`), jsonClean(sample));
  }
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
