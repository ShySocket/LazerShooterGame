import type { ProfilesSnapshot, ShotSample } from './sample';

/**
 * On-phone storage for shot feedback. Photos and unlabelled samples live here between the round and
 * the results screen (IndexedDB, so a reload on the way does not lose them), and uploads that failed
 * for lack of a connection wait here for the next chance. Nothing in this store leaves the phone
 * except a sample the shooter explicitly labelled, and photos never do.
 */
export interface StoredRound {
  key: string;
  code: string;
  startAt: number;
  /** Real player ids behind p0, p1, ...; never uploaded. */
  ids: string[];
  profiles: ProfilesSnapshot;
  /** Set once the review card was answered or skipped; the round is never asked about again. */
  reviewed: boolean;
}

export interface StoredShot {
  id: string;
  round: string;
  outcome: string;
  hadTrack: boolean;
  roundMs: number;
  sample: ShotSample;
  photo: Blob | null;
}

export interface QueuedUpload {
  id: string;
  round: string;
  sample: ShotSample;
  profiles: ProfilesSnapshot | null;
  attempts: number;
}

/** Failed shots kept per round; the oldest go first once the cap is reached. */
export const MAX_SHOTS_PER_ROUND = 40;
/**
 * A queued upload refused this many times is dropped: either it already went through (its key is
 * write-once) or the database rules were never published, and the queue is not a permanent archive.
 */
export const MAX_UPLOAD_ATTEMPTS = 12;
/** A round nobody reviewed within this long is dropped with its photos; nobody reviews yesterday's shots. */
const ROUND_TTL_MS = 6 * 3600 * 1000;
const DB_NAME = 'lz-feedback';
const DB_VERSION = 1;
type StoreName = 'rounds' | 'shots' | 'queue';

interface Backing {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T extends object>(store: StoreName, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  all<T>(store: StoreName): Promise<T[]>;
}

const KEY_PATH: Record<StoreName, string> = { rounds: 'key', shots: 'id', queue: 'id' };

class MemoryBacking implements Backing {
  private data: Record<StoreName, Map<string, unknown>> = { rounds: new Map(), shots: new Map(), queue: new Map() };
  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.data[store].get(key) as T | undefined;
  }
  async put<T extends object>(store: StoreName, value: T): Promise<void> {
    this.data[store].set(String((value as Record<string, unknown>)[KEY_PATH[store]]), value);
  }
  async delete(store: StoreName, key: string): Promise<void> {
    this.data[store].delete(key);
  }
  async all<T>(store: StoreName): Promise<T[]> {
    return [...this.data[store].values()] as T[];
  }
}

class IdbBacking implements Backing {
  constructor(private db: IDBDatabase) {}

  static open(): Promise<IdbBacking> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of Object.keys(KEY_PATH) as StoreName[]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: KEY_PATH[name] });
        }
      };
      req.onsuccess = () => resolve(new IdbBacking(req.result));
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
      req.onblocked = () => reject(new Error('indexedDB blocked'));
    });
  }

  private run<T>(store: StoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const req = op(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
    });
  }

  get<T>(store: StoreName, key: string): Promise<T | undefined> {
    return this.run<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  }
  async put<T extends object>(store: StoreName, value: T): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.put(value));
  }
  async delete(store: StoreName, key: string): Promise<void> {
    await this.run(store, 'readwrite', (s) => s.delete(key));
  }
  all<T>(store: StoreName): Promise<T[]> {
    return this.run<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  }
}

export class FeedbackStore {
  private backing: Promise<Backing>;

  constructor(backing?: Backing) {
    this.backing = backing ? Promise.resolve(backing) : FeedbackStore.openBacking();
  }

  private static async openBacking(): Promise<Backing> {
    try {
      if (typeof indexedDB === 'undefined') return new MemoryBacking();
      return await IdbBacking.open();
    } catch (e) {
      console.warn('feedback store falling back to memory', e);
      return new MemoryBacking();
    }
  }

  /** Any failure of the phone's storage must never reach the game loop. */
  private async safe<T>(fallback: T, op: (b: Backing) => Promise<T>): Promise<T> {
    try {
      return await op(await this.backing);
    } catch (e) {
      console.warn('feedback store', e);
      return fallback;
    }
  }

  /**
   * A round started: remember its players and profiles. Every earlier round goes, photos included:
   * a shot nobody reviewed before the next round began is not worth asking about later.
   */
  beginRound(round: Omit<StoredRound, 'reviewed'>): Promise<void> {
    return this.safe(undefined, async (b) => {
      for (const r of await b.all<StoredRound>('rounds')) if (r.key !== round.key) await this.dropRound(b, r.key);
      const existing = await b.get<StoredRound>('rounds', round.key);
      await b.put('rounds', { ...round, reviewed: existing?.reviewed ?? false });
    });
  }

  private async dropRound(b: Backing, key: string): Promise<void> {
    for (const s of await b.all<StoredShot>('shots')) if (s.round === key) await b.delete('shots', s.id);
    await b.delete('rounds', key);
  }

  saveShot(shot: StoredShot): Promise<void> {
    return this.safe(undefined, async (b) => {
      const same = (await b.all<StoredShot>('shots')).filter((s) => s.round === shot.round).sort((x, y) => x.roundMs - y.roundMs);
      while (same.length >= MAX_SHOTS_PER_ROUND) await b.delete('shots', same.shift()!.id);
      await b.put('shots', shot);
    });
  }

  /** The newest round on this phone that has not been reviewed yet, with its stored shots. */
  pendingReview(): Promise<{ round: StoredRound; shots: StoredShot[] } | null> {
    return this.safe(null, async (b) => {
      const rounds = (await b.all<StoredRound>('rounds')).filter((r) => !r.reviewed).sort((x, y) => y.startAt - x.startAt);
      const round = rounds[0];
      if (!round) return null;
      if (Date.now() - round.startAt > ROUND_TTL_MS) {
        await this.dropRound(b, round.key);
        return null;
      }
      const shots = (await b.all<StoredShot>('shots')).filter((s) => s.round === round.key).sort((x, y) => x.roundMs - y.roundMs);
      return { round, shots };
    });
  }

  deleteShot(id: string): Promise<void> {
    return this.safe(undefined, (b) => b.delete('shots', id));
  }

  /** The round's review is over: drop every photo it still holds. */
  finishReview(key: string): Promise<void> {
    return this.safe(undefined, async (b) => {
      for (const s of await b.all<StoredShot>('shots')) if (s.round === key) await b.delete('shots', s.id);
      const round = await b.get<StoredRound>('rounds', key);
      if (round) await b.put('rounds', { ...round, reviewed: true });
    });
  }

  enqueue(upload: Omit<QueuedUpload, 'attempts'>): Promise<void> {
    return this.safe(undefined, (b) => b.put('queue', { ...upload, attempts: 0 }));
  }

  /** Retry every queued upload; whatever still fails stays queued. Returns how many went through. */
  flush(send: (u: QueuedUpload) => Promise<void>): Promise<number> {
    return this.safe(0, async (b) => {
      let sent = 0;
      for (const u of await b.all<QueuedUpload>('queue')) {
        try {
          await send(u);
          await b.delete('queue', u.id);
          sent++;
        } catch {
          if (u.attempts + 1 >= MAX_UPLOAD_ATTEMPTS) await b.delete('queue', u.id);
          else await b.put('queue', { ...u, attempts: u.attempts + 1 });
        }
      }
      return sent;
    });
  }

  queued(): Promise<QueuedUpload[]> {
    return this.safe([], (b) => b.all<QueuedUpload>('queue'));
  }
}

export const feedbackStore = new FeedbackStore();
export { MemoryBacking };
