import { Human, type Config } from '@vladmandic/human';
import { createSerialQueue } from './serial';
import { clearModelCaches } from './modelCache';
import { BODY_CAP } from './calibration';
export { MODELS_CACHE, STALE_MODEL_CACHES, clearModelCaches } from './modelCache';
export * from './embedding';

const modelBasePath = import.meta.env.BASE_URL.replace(/\/?$/, '/') + 'models/';

export const humanConfig: Partial<Config> = {
  modelBasePath,
  debug: false,
  // Compile shaders during loading, not on the first live frame of a round.
  warmup: 'full',
  cacheSensitivity: 0,
  // No image effects are used, so skip Human's full-resolution filter pass on every frame.
  filter: { enabled: false },
  face: {
    enabled: true,
    // Tighter crop than Human's default 1.4 because ArcFace-family models expect a close face box.
    detector: { rotation: true, maxDetected: 6, minConfidence: 0.5, minSize: 18, return: false, scale: 1.2, skipFrames: 0, skipTime: 0 },
    // Mesh gives a steadier crop and the head yaw angle so turned faces can be skipped.
    mesh: { enabled: true },
    attention: { enabled: false },
    iris: { enabled: false },
    // The bundled FaceRes descriptor is too weak to separate similar faces. Replaced by InsightFace below.
    description: { enabled: false },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
    gear: { enabled: false },
    // Untyped in Human's config but honoured by the pipeline: overwrites face.embedding with a 512-d ArcFace vector.
    ...({ insightface: { enabled: true, modelPath: 'insightface-ghostnet-strides1.json', skipFrames: 0, skipTime: 0 } } as object),
  },
  body: { enabled: true, modelPath: 'movenet-multipose.json', maxDetected: BODY_CAP, minConfidence: 0.25, skipFrames: 0, skipTime: 0 },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

/**
 * The full-frame pass only needs face boxes (for association and crop windows) and bodies. The
 * mesh and the embedding model run on the magnified crops, so paying for them on every full-frame
 * face would only slow the loop down on a phone. Human keeps one mutable config, so the two passes
 * flip these flags before each detect call inside the same serialized session.
 */
export type HumanPass = 'frame' | 'crop' | 'face';

export function configurePass(h: Human, pass: HumanPass): void {
  const crop = pass === 'crop';
  h.config.face.mesh!.enabled = crop;
  (h.config.face as unknown as { insightface: { enabled: boolean } }).insightface.enabled = crop;
  // The enrolment face stage wants face boxes alone: the body model would only cost time there.
  h.config.body.enabled = pass === 'frame';
}

let instance: Human | null = null;
let loading: Promise<Human> | null = null;
let ready = false;
/** Bumped by abandonHumanLoad so a load left behind cannot mark a later instance ready. */
let generation = 0;

/** The models the game needs, checked after Human's load (it logs some download failures without rejecting). */
export const REQUIRED_MODELS = ['blazeface', 'facemesh', 'insightface-ghostnet-strides1', 'movenet-multipose'];


/** Progress of the current load: which required models are in, and how many bytes so far. */
export function modelStats(): { name: string; loaded: boolean; sizeLoadedWeights: number }[] {
  return instance ? instance.models.stats().modelStats.map((m) => ({ name: m.name, loaded: m.loaded, sizeLoadedWeights: m.sizeLoadedWeights })) : [];
}

/**
 * Give up on a download that has stalled: the next loadHuman() starts over on a fresh instance. The
 * abandoned load keeps running in the background and is ignored if it ever finishes.
 */
export function abandonHumanLoad(): void {
  generation++;
  loading = null;
  ready = false;
  // Release the old instance's GPU tensors before the next load builds a fresh set.
  const old = instance;
  instance = null;
  if (old) {
    try {
      for (const model of Object.values(old.models.models)) (model as { dispose?: () => void } | null)?.dispose?.();
    } catch {
      /* best effort */
    }
  }
}

// Human keeps mutable config and model caches. A frame and all its crops form one session.
export const withHumanSession = createSerialQueue();

// Development only: lets tuning scripts in the browser console reuse the app's loaded models.
if (import.meta.env.DEV) (window as unknown as { __lzHuman?: unknown }).__lzHuman = { getHuman: () => getHuman(), loadHuman: () => loadHuman() };

export function getHuman(): Human {
  if (!instance) instance = new Human(humanConfig);
  return instance;
}

export function isHumanReady(): boolean {
  return ready;
}

/** Loads models once; safe to call from many places. A failed load is forgotten so the next call retries. */
export function loadHuman(onStatus?: (msg: string) => void): Promise<Human> {
  if (!loading) {
    const mine = generation;
    loading = (async () => {
      const h = getHuman();
      onStatus?.('Loading vision models');
      await h.load(humanConfig);
      // Human logs some download failures without rejecting load(). Do not report a partial load as ready.
      const stats = h.models.stats().modelStats;
      const missing = REQUIRED_MODELS.filter((name) => !stats.some((model) => model.name === name && model.loaded));
      if (missing.length) {
        await clearModelCaches();
        throw new Error('Could not load vision models: ' + missing.join(', '));
      }
      onStatus?.('Warming up');
      const result = await h.warmup();
      if (result?.error) throw new Error(result.error);
      if (mine === generation) ready = true;
      onStatus?.('Ready');
      return h;
    })().catch((e: unknown) => {
      if (mine === generation) {
        ready = false;
        loading = null;
        // Reset also invalidates Human's module-level model caches for the next load attempt.
        getHuman().reset();
      }
      throw e;
    });
  }
  return loading;
}

