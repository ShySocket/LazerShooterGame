import { getDatabase, ref, set, update, get, onValue, onDisconnect, runTransaction, push, type Database } from 'firebase/database';
import type { Player, Profile, Room, RoomMeta } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { applyHit, newPlayer, pickColor, randomCode, type HitOutcome, type PlayerSeed, type RoomBackend } from './backend';
import { firebaseApp } from './firebaseApp';

export { hasFirebaseConfig } from './firebaseApp';

export class FirebaseBackend implements RoomBackend {
  readonly mode = 'firebase' as const;
  private db: Database;
  private offset = 0;

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
      await set(ref(this.db, this.path(code)), {
        meta,
        players: { [host.id]: newPlayer(host, pickColor(undefined), DEFAULT_SETTINGS.lives, this.now()) },
      });
      this.attachPresence(code, host.id);
      return code;
    }
    throw new Error('Could not allocate a room code, try again');
  }

  async joinRoom(code: string, player: PlayerSeed): Promise<boolean> {
    const meta = await get(ref(this.db, this.path(code, 'meta')));
    if (!meta.exists()) return false;
    const playersSnap = await get(ref(this.db, this.path(code, 'players')));
    const players = (playersSnap.val() as Record<string, Player> | null) ?? {};
    const me = ref(this.db, this.path(code, `players/${player.id}`));
    if (players[player.id]) {
      await update(me, { connected: true, name: player.name });
    } else {
      const settings = (meta.val() as RoomMeta).settings ?? DEFAULT_SETTINGS;
      await set(me, newPlayer(player, pickColor(players), settings.lives, this.now()));
    }
    this.attachPresence(code, player.id);
    return true;
  }

  private attachPresence(code: string, id: string): void {
    const r = ref(this.db, this.path(code, `players/${id}/connected`));
    void onDisconnect(r).set(false);
    void set(r, true);
  }

  subscribe(code: string, cb: (room: Room | null) => void): () => void {
    let meta: RoomMeta | null = null;
    let gotMeta = false;
    let players: Record<string, Player> = {};
    let profiles: Record<string, Profile> = {};
    const emit = () => {
      if (!gotMeta) return;
      cb(meta ? { ...meta, players, profiles } : null);
    };
    const u1 = onValue(ref(this.db, this.path(code, 'meta')), (s) => {
      meta = s.val() as RoomMeta | null;
      gotMeta = true;
      emit();
    });
    const u2 = onValue(ref(this.db, this.path(code, 'players')), (s) => {
      players = (s.val() as Record<string, Player> | null) ?? {};
      emit();
    });
    const u3 = onValue(ref(this.db, this.path(code, 'profiles')), (s) => {
      profiles = (s.val() as Record<string, Profile> | null) ?? {};
      emit();
    });
    return () => {
      u1();
      u2();
      u3();
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

  async resetForNewRound(code: string): Promise<void> {
    const metaSnap = await get(ref(this.db, this.path(code, 'meta')));
    const meta = metaSnap.val() as RoomMeta | null;
    if (!meta) return;
    const playersSnap = await get(ref(this.db, this.path(code, 'players')));
    const players = (playersSnap.val() as Record<string, Player> | null) ?? {};
    const patch: Record<string, unknown> = {
      'meta/status': 'lobby',
      'meta/startAt': null,
      'meta/endedAt': null,
      'meta/winnerId': null,
      events: null,
    };
    for (const id of Object.keys(players)) {
      patch[`players/${id}/lives`] = meta.settings.lives;
      patch[`players/${id}/status`] = 'alive';
      patch[`players/${id}/lastHitAt`] = 0;
      patch[`players/${id}/eliminatedAt`] = null;
      patch[`players/${id}/tags`] = 0;
    }
    await update(ref(this.db, this.path(code)), patch);
  }

  async registerHit(code: string, shooter: string, target: string, score: number, via: string): Promise<HitOutcome> {
    const metaSnap = await get(ref(this.db, this.path(code, 'meta')));
    const meta = metaSnap.val() as RoomMeta | null;
    if (!meta || meta.status !== 'playing') return 'invalid';
    const now = this.now();
    const state = { outcome: 'invalid' as HitOutcome };
    const res = await runTransaction(ref(this.db, this.path(code, `players/${target}`)), (current: Player | null) => {
      const r = applyHit(current, now, meta.settings.invulnMs);
      state.outcome = r.outcome;
      return r.next; // undefined aborts the transaction
    });
    const outcome = state.outcome;
    if (!res.committed) return outcome;
    if (outcome === 'hit' || outcome === 'eliminated') {
      void runTransaction(ref(this.db, this.path(code, `players/${shooter}/tags`)), (t: number | null) => (t ?? 0) + 1);
      void push(ref(this.db, this.path(code, 'events')), { shooter, target, t: now, score, via });
    }
    return outcome;
  }
}

function stripUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}
