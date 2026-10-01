import type { DbSdk } from '../../src/net/firebase';

/**
 * An in-memory stand-in for the slice of the Realtime Database SDK that FirebaseBackend uses.
 * Paths are plain object keys; `.info/connected` and `.info/serverTimeOffset` are served from
 * `info`. Transactions model the server's optimistic concurrency: the update function runs on the
 * value read at the start, the commit is deferred to a timer so calls made in the same tick all
 * read the same snapshot, and a commit that finds the node changed since its read re-runs the
 * function on the fresh value (which is what makes closures inside the function see the last run).
 * Like the SDK, a client's own set or update at, above or below one of its pending transactions
 * aborts that transaction with Error('set'); each sdk() call is one client. A client made with
 * `latencyMs` takes that long for each transaction write's round trip, so another client's commit in
 * that window makes it re-run on the fresh value later. `dropNextAnswer` models the socket dropping
 * after a transaction write was sent: the SDK rejects it with Error('disconnect') whether or not the
 * server applied it ('applied') or never saw it ('lost').
 */
type Path = string[];
interface FakeRef {
  path: Path;
}
interface Snap {
  val(): unknown;
  exists(): boolean;
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export class FakeDb {
  root: Record<string, unknown> = {};
  info: { connected: boolean; serverTimeOffset: number } = { connected: true, serverTimeOffset: 0 };
  version = 0;
  /** Every onDisconnect arm or cancel, in order. */
  disconnects: { path: string; action: 'set' | 'cancel'; value?: unknown }[] = [];
  /** How many transaction commits were retried because the node changed under them. */
  retries = 0;
  /** Every transaction's path, in order, and how many were aborted by their own client's write. */
  transactions: string[] = [];
  aborts = 0;
  /** The next committing transaction's answer is lost to a dropped socket (see the class comment). */
  dropNextAnswer: 'applied' | 'lost' | null = null;
  private listeners: { path: Path; cb: (s: Snap) => void }[] = [];

  readAt(path: Path): unknown {
    if (path[0] === '.info') return path[1] === 'connected' ? this.info.connected : path[1] === 'serverTimeOffset' ? this.info.serverTimeOffset : null;
    let node: unknown = this.root;
    for (const key of path) {
      if (!isObj(node) || !(key in node)) return null;
      node = node[key];
    }
    return node === undefined ? null : clone(node);
  }

  private snap(path: Path): Snap {
    const v = this.readAt(path);
    return { val: () => v, exists: () => v !== null };
  }

  private writeSilently(path: Path, value: unknown): void {
    if (path.length === 0) {
      this.root = isObj(value) ? (clone(value) as Record<string, unknown>) : {};
      return;
    }
    let node = this.root;
    for (const key of path.slice(0, -1)) {
      if (!isObj(node[key])) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = clone(value);
    this.version++;
  }

  private notify(paths: Path[]): void {
    const touched = (l: Path) => paths.some((p) => p.slice(0, Math.min(p.length, l.length)).join('/') === l.slice(0, Math.min(p.length, l.length)).join('/'));
    for (const l of [...this.listeners]) if (touched(l.path)) l.cb(this.snap(l.path));
  }

  writeAt(path: Path, value: unknown): void {
    this.writeSilently(path, value);
    this.notify([path]);
  }

  /**
   * A change the server already has but no listener on this phone has heard yet (a dropped socket, an
   * update still in flight): subscriptions keep their old value, transactions see the new one.
   */
  writeUnheard(path: Path, value: unknown): void {
    this.writeSilently(path, value);
  }

  /** The SDK surface, cast for injection into FirebaseBackend. */
  sdk({ latencyMs = 0 }: { latencyMs?: number } = {}): DbSdk {
    const db = this;
    /** This client's transactions in flight; a write of its own that overlaps one aborts it. */
    const pending = new Set<{ path: Path; aborted: boolean }>();
    const overlaps = (a: Path, b: Path) => a.slice(0, Math.min(a.length, b.length)).join('/') === b.slice(0, Math.min(a.length, b.length)).join('/');
    const abortOverlapping = (path: Path) => {
      for (const t of pending) if (overlaps(t.path, path)) t.aborted = true;
    };
    const api = {
      ref: (_db: unknown, path = ''): FakeRef => ({ path: path.split('/').filter(Boolean) }),
      get: async (r: FakeRef): Promise<Snap> => db.snap(r.path),
      set: async (r: FakeRef, v: unknown): Promise<void> => {
        abortOverlapping(r.path);
        db.writeAt(r.path, v);
      },
      update: async (r: FakeRef, patch: Record<string, unknown>): Promise<void> => {
        const paths: Path[] = [];
        for (const [k, v] of Object.entries(patch)) {
          const p = [...r.path, ...k.split('/').filter(Boolean)];
          abortOverlapping(p);
          db.writeSilently(p, v);
          paths.push(p);
        }
        db.notify(paths);
      },
      onValue: (r: FakeRef, cb: (s: Snap) => void): (() => void) => {
        const entry = { path: r.path, cb };
        db.listeners.push(entry);
        cb(db.snap(r.path));
        return () => {
          db.listeners = db.listeners.filter((l) => l !== entry);
        };
      },
      onDisconnect: (r: FakeRef) => ({
        set: async (v: unknown) => {
          db.disconnects.push({ path: r.path.join('/'), action: 'set', value: v });
        },
        cancel: async () => {
          db.disconnects.push({ path: r.path.join('/'), action: 'cancel' });
        },
      }),
      runTransaction: async (r: FakeRef, fn: (v: unknown) => unknown): Promise<{ committed: boolean; snapshot: Snap }> => {
        db.transactions.push(r.path.join('/'));
        const me = { path: r.path, aborted: false };
        pending.add(me);
        try {
          for (let attempt = 0; attempt < 25; attempt++) {
            const before = db.version;
            const current = db.readAt(r.path);
            await new Promise((res) => setTimeout(res, 0));
            if (me.aborted) {
              db.aborts++;
              throw new Error('set');
            }
            const next = fn(current);
            // The write's round trip; a commit by anyone else meanwhile makes it stale.
            if (latencyMs > 0 && next !== undefined) await new Promise((res) => setTimeout(res, latencyMs));
            if (db.version !== before) {
              db.retries++;
              continue;
            }
            if (next === undefined) return { committed: false, snapshot: db.snap(r.path) };
            const dropped = db.dropNextAnswer;
            db.dropNextAnswer = null;
            if (dropped !== 'lost') db.writeAt(r.path, next);
            if (dropped) throw new Error('disconnect');
            return { committed: true, snapshot: db.snap(r.path) };
          }
          throw new Error('maxretry');
        } finally {
          pending.delete(me);
        }
      },
    };
    return api as unknown as DbSdk;
  }
}
