import type { DbSdk } from '../../src/net/firebase';

/**
 * An in-memory stand-in for the slice of the Realtime Database SDK that FirebaseBackend uses.
 * Paths are plain object keys; `.info/connected` and `.info/serverTimeOffset` are served from
 * `info`. Transactions model the server's optimistic concurrency: the update function runs on the
 * value read at the start, the commit is deferred to a timer so calls made in the same tick all
 * read the same snapshot, and a commit that finds the node changed since its read re-runs the
 * function on the fresh value (which is what makes closures inside the function see the last run).
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
  private listeners: { path: Path; cb: (s: Snap) => void }[] = [];
  private pushCount = 0;

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

  /** The SDK surface, cast for injection into FirebaseBackend. */
  sdk(): DbSdk {
    const db = this;
    const api = {
      ref: (_db: unknown, path = ''): FakeRef => ({ path: path.split('/').filter(Boolean) }),
      get: async (r: FakeRef): Promise<Snap> => db.snap(r.path),
      set: async (r: FakeRef, v: unknown): Promise<void> => db.writeAt(r.path, v),
      update: async (r: FakeRef, patch: Record<string, unknown>): Promise<void> => {
        const paths: Path[] = [];
        for (const [k, v] of Object.entries(patch)) {
          const p = [...r.path, ...k.split('/').filter(Boolean)];
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
        for (let attempt = 0; attempt < 25; attempt++) {
          const before = db.version;
          const current = db.readAt(r.path);
          await new Promise((res) => setTimeout(res, 0));
          const next = fn(current);
          if (db.version !== before) {
            db.retries++;
            continue;
          }
          if (next === undefined) return { committed: false, snapshot: db.snap(r.path) };
          db.writeAt(r.path, next);
          return { committed: true, snapshot: db.snap(r.path) };
        }
        throw new Error('transaction never settled');
      },
      push: async (r: FakeRef, v: unknown): Promise<FakeRef> => {
        const key = `k${++db.pushCount}`;
        db.writeAt([...r.path, key], v);
        return { path: [...r.path, key] };
      },
    };
    return api as unknown as DbSdk;
  }
}
