import type { RoomBackend } from '../net/backend';
import type { Profile, Room } from '../types';
import { FACE_EMBEDDING_SIZE, FACE_MODEL, FACE_SAMPLES } from '../vision/embedding';
import { shotLog } from '../debug/shotLog';

/**
 * Browser end-to-end tests (tests/e2e, `npm run e2e`) open the game with `?e2e` on a dev build. The
 * flag does three things, all of them DEV only: the vision models count as ready without loading,
 * the vision loop stays off (Chrome's fake camera shows no people anyway), and `window.__lzE2E`
 * lets a test enrol a synthetic profile and register hits through the real backend. Production
 * builds strip all of it because `import.meta.env.DEV` is false.
 */
export const isE2E = (): boolean => Boolean(import.meta.env.DEV) && new URL(location.href).searchParams.has('e2e');
/**
 * `?e2e&vision`: the real models load and the vision loop runs on the (file-fed) fake camera, for
 * tests/e2e/realvision.spec.ts. Plain `?e2e` keeps the models and the loop stubbed.
 */
export const isE2EVision = (): boolean => isE2E() && new URL(location.href).searchParams.has('vision');
/** The models and the vision loop are stubbed out (plain ?e2e). */
export const e2eStubsVision = (): boolean => isE2E() && !isE2EVision();

const SIG_LEN = 51;
const HUE_BINS = 48;

const lcg = (seed: number) => {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 0xffffffff - 0.5;
  };
};

const unit = (v: number[]): number[] => {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

/** A one-hot colour histogram at a hue bin, so two seeds far apart never read as the same outfit. */
const sig = (bin: number): number[] => {
  const out = new Array<number>(SIG_LEN).fill(0);
  out[((bin % HUE_BINS) + HUE_BINS) % HUE_BINS] = 1;
  return out;
};

/** A complete, valid profile for player `seed`: eight distinct face vectors and a distinct outfit. `twin` copies another seed's outfit. */
export function syntheticProfile(seed: number, twin?: number): Profile {
  const rnd = lcg(seed + 1);
  const face = Array.from({ length: FACE_SAMPLES }, () => unit(Array.from({ length: FACE_EMBEDDING_SIZE }, rnd)));
  const hue = (twin ?? seed) * 7;
  const side = { top: sig(hue), thighs: sig(hue + 17), shins: sig(hue + 29), hair: sig(hue + 41) };
  return { faceModel: FACE_MODEL, face, outfit: { front: side, back: side } };
}

export interface E2EHook {
  pid: () => string | null;
  code: () => string | null;
  room: (code?: string) => Promise<Room | null>;
  enroll: (seed: number, twin?: number) => Promise<void>;
  /** Enrol from real frames with the real models (?e2e&vision only); resolves to the face sample count. */
  enrollFromImages: (urls: string[], seed: number) => Promise<number>;
  hit: (shooter: string, target: string) => Promise<string>;
  deleteRoom: (code: string) => Promise<void>;
  /** Outcomes of every FIRE press on this phone this round, oldest first. */
  shots: () => string[];
  /** What the backend says when asked to end the round now (diagnostics for the winner test). */
  endRound: () => Promise<string>;
}

export function installE2E(backend: RoomBackend): void {
  const code = () => new URL(location.href).searchParams.get('room');
  const pid = () => localStorage.getItem('lz:pid');
  const room = (c = code()) =>
    new Promise<Room | null>((resolve) => {
      if (!c) return resolve(null);
      // The callback can fire synchronously from the SDK's cache, before subscribe() has returned.
      let unsubscribe: (() => void) | null = null;
      let done = false;
      const u = backend.subscribe(c, (r) => {
        resolve(r);
        done = true;
        if (unsubscribe) setTimeout(unsubscribe, 0);
      });
      unsubscribe = u;
      if (done) setTimeout(u, 0);
    });
  const hook: E2EHook = {
    pid,
    code,
    room,
    enroll: async (seed, twin) => {
      const c = code();
      const id = pid();
      if (!c || !id) throw new Error('not in a room');
      await backend.setProfile(c, id, syntheticProfile(seed, twin));
    },
    enrollFromImages: async (urls, seed) => {
      const c = code();
      const id = pid();
      if (!c || !id) throw new Error('not in a room');
      const { profileFromImages } = await import('./realProfile');
      const profile = await profileFromImages(urls, syntheticProfile(seed).outfit);
      await backend.setProfile(c, id, profile);
      return profile.face.length;
    },
    hit: async (shooter, target) => {
      const c = code();
      if (!c) throw new Error('not in a room');
      return backend.registerHit(c, shooter, target, 0.9, 'e2e');
    },
    shots: () => shotLog.all().map((s) => s.outcome),
    endRound: async () => {
      const c = code();
      if (!c) throw new Error('not in a room');
      return backend.endRound(c);
    },
    deleteRoom: async (c) => {
      if (backend.mode !== 'firebase') return;
      const { getDatabase, ref, set } = await import('firebase/database');
      const { firebaseApp } = await import('../net/firebaseApp');
      await set(ref(getDatabase(firebaseApp()), `rooms/${c}`), null);
    },
  };
  (window as unknown as { __lzE2E?: E2EHook }).__lzE2E = hook;
}
