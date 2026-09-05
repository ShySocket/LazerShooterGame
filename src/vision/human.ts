import { Human, type Config } from '@vladmandic/human';

const modelBasePath = import.meta.env.BASE_URL.replace(/\/?$/, '/') + 'models/';

export const humanConfig: Partial<Config> = {
  modelBasePath,
  debug: false,
  warmup: 'none',
  cacheSensitivity: 0,
  filter: { enabled: true, equalization: false, flip: false },
  face: {
    enabled: true,
    detector: { rotation: false, maxDetected: 6, minConfidence: 0.5, minSize: 18, return: false },
    mesh: { enabled: false },
    attention: { enabled: false },
    iris: { enabled: false },
    description: { enabled: true, minConfidence: 0.4 },
    emotion: { enabled: false },
    antispoof: { enabled: false },
    liveness: { enabled: false },
    gear: { enabled: false },
  },
  body: { enabled: true, modelPath: 'movenet-multipose.json', maxDetected: 6, minConfidence: 0.25 },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
};

let instance: Human | null = null;
let loading: Promise<Human> | null = null;
let ready = false;

export function getHuman(): Human {
  if (!instance) instance = new Human(humanConfig);
  return instance;
}

export function isHumanReady(): boolean {
  return ready;
}

/** Loads models once; safe to call from many places. */
export function loadHuman(onStatus?: (msg: string) => void): Promise<Human> {
  if (!loading) {
    loading = (async () => {
      const h = getHuman();
      onStatus?.('Loading vision models');
      await h.load();
      onStatus?.('Warming up');
      await h.warmup();
      ready = true;
      onStatus?.('Ready');
      return h;
    })();
  }
  return loading;
}

export function faceSimilarity(a: number[], b: number[]): number {
  return getHuman().match.similarity(a, b);
}

/** Round embeddings so they are small enough to sync comfortably. */
export function compactEmbedding(e: number[]): number[] {
  return e.map((v) => Math.round(v * 10000) / 10000);
}
