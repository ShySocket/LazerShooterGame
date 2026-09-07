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
    // Tighter crop than Human's default 1.4 because ArcFace-family models expect a close face box.
    detector: { rotation: true, maxDetected: 6, minConfidence: 0.5, minSize: 18, return: false, scale: 1.2 },
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
    ...({ insightface: { enabled: true, modelPath: 'insightface-mobilenet-swish.json' } } as object),
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

/** Name of the descriptor model behind the embeddings. Profiles made with another model are ignored. */
export const FACE_MODEL = 'insightface-mobilenet-swish';

/**
 * Cosine similarity calibration for FACE_MODEL: below reject is a different person, above accept the same.
 * ArcFace-family models separate people around 0.3 to 0.5 with proper alignment; Human's crop is looser,
 * so these start conservative. Tune with the shot log.
 */
export const FACE_CALIB = { reject: 0.28, accept: 0.6 };

/** Enrollment sanity check: frames of one person should score at least this against frame 1. */
export const SAME_PERSON_MIN = 0.25;

/** Faces turned more than this (degrees of yaw) are too oblique for a reliable embedding. */
export const MAX_YAW_DEG = 45;

function normalize(e: number[]): number[] {
  let n = 0;
  for (const v of e) n += v * v;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  return e.map((v) => v * inv);
}

/** Cosine similarity in 0..1. Model output is not unit length, so both sides are normalised first. */
export function faceSimilarity(a: number[], b: number[]): number {
  const na = normalize(a);
  const nb = normalize(b);
  let dot = 0;
  const n = Math.min(na.length, nb.length);
  for (let i = 0; i < n; i++) dot += na[i] * nb[i];
  return Math.max(0, dot);
}

/** Unit-length embeddings rounded so they are small enough to sync comfortably. */
export function compactEmbedding(e: number[]): number[] {
  return normalize(e).map((v) => Math.round(v * 10000) / 10000);
}

/** Head yaw in degrees when the mesh reports it, else 0. */
export function faceYawDeg(f: { rotation?: { angle?: { yaw?: number } } | null }): number {
  return Math.abs(((f.rotation?.angle?.yaw ?? 0) * 180) / Math.PI);
}
