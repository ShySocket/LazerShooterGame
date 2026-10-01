import type { Human } from '@vladmandic/human';
import { compactEmbedding, configurePass, faceYawDeg, getHuman, humanConfig, isValidEmbedding, loadHuman, withHumanSession } from '../vision/human';
import { faceRegion, ZoomPass } from '../vision/zoom';
import { toNBox } from '../vision/geometry';

/**
 * Real-model probe (dev builds, ?realcheck). scripts/realcheck.mjs drives it from Playwright to run
 * the game's own models on real photos and video frames: the same full-frame pass and square zoom
 * crops the game uses, so the numbers it reports are what a phone would see. Nothing here ships.
 */

export interface ProbeFace {
  /** Full-frame face box, normalised. */
  box: [number, number, number, number];
  /** Face height in source-image pixels. */
  px: number;
  score: number;
  yaw: number;
  /** Signed yaw in degrees from the crop mesh (the scan's readout), NaN when missing. */
  yawSigned: number;
  /** Signed pitch in degrees from the crop mesh, NaN when missing. */
  pitch: number;
  /** Unit embedding from the zoom crop (the only embedding source in the game), empty when none. */
  embedding: number[];
  /**
   * Wall time of this face's zoom crop pass (square crop drawn, then face detector + mesh + the
   * embedding model on it, results read back), in ms: what one crop costs the game per frame.
   */
  cropMs: number;
}

export interface ProbeImage {
  width: number;
  height: number;
  faces: ProbeFace[];
  bodies: number;
  ms: number;
}

const zoom = new ZoomPass();

let candidateLoad: Promise<Human> | null = null;
/** The shipped loader insists on the shipped face model; a candidate model is loaded directly. */
function probeHuman(): Promise<Human> {
  if (!new URL(location.href).searchParams.get('face')) return loadHuman();
  candidateLoad ??= (async () => {
    const h = getHuman();
    // No warmup: Human's warmup pass crashes with some candidate models. The first crops of a page
    // therefore include shader compilation; scripts/realcheck.ts reports the median crop time.
    await h.load(humanConfig);
    return h;
  })();
  return candidateLoad;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not load ' + src));
    img.src = src;
  });
}

/** Letterbox into a square canvas: Human distorts non-square inputs. */
function squareCanvas(img: HTMLImageElement | HTMLVideoElement, w: number, h: number): HTMLCanvasElement {
  const side = Math.max(w, h);
  const c = document.createElement('canvas');
  c.width = side;
  c.height = side;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, side, side);
  ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
  return c;
}

async function probeCanvas(canvas: HTMLCanvasElement): Promise<ProbeImage> {
  const human = await probeHuman();
  const t0 = performance.now();
  return withHumanSession(async () => {
    configurePass(human, 'frame');
    const res = await human.detect(canvas);
    const faces: ProbeFace[] = [];
    for (const f of res.face) {
      const fb = toNBox(f.boxRaw);
      const tc = performance.now();
      const crops = await zoom.run(human, canvas, faceRegion(fb, canvas.width / canvas.height, 6));
      const cropMs = performance.now() - tc;
      const own = crops
        .map((c) => ({ c, dist: Math.hypot(c.box[0] + c.box[2] / 2 - fb[0] - fb[2] / 2, c.box[1] + c.box[3] / 2 - fb[1] - fb[3] / 2) }))
        .filter((x) => x.dist < fb[3])
        .sort((a, b) => a.dist - b.dist)[0]?.c;
      const pitch = own?.face.rotation?.angle?.pitch;
      const yawRad = own?.face.rotation?.angle?.yaw;
      faces.push({
        box: fb,
        px: fb[3] * canvas.height,
        score: f.score,
        yaw: own ? faceYawDeg(own.face) : NaN,
        yawSigned: typeof yawRad === 'number' ? (yawRad * 180) / Math.PI : NaN,
        pitch: typeof pitch === 'number' ? (pitch * 180) / Math.PI : NaN,
        embedding: own && isValidEmbedding(own.face.embedding) ? compactEmbedding(own.face.embedding) : [],
        cropMs,
      });
    }
    return { width: canvas.width, height: canvas.height, faces, bodies: res.body.length, ms: performance.now() - t0 };
  });
}

/** One camera frame from an image file, as the camera gives it (not squared, like the game's frame pass). */
export async function probeFrame(src: string): Promise<ProbeImage> {
  const img = await loadImage(src);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  return probeCanvas(c);
}

export async function probeImage(src: string): Promise<ProbeImage> {
  const img = await loadImage(src);
  return probeCanvas(squareCanvas(img, img.naturalWidth, img.naturalHeight));
}

function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.onloadeddata = () => resolve(v);
    v.onerror = () => reject(new Error('could not load ' + src));
    v.src = src;
  });
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    v.onseeked = () => resolve();
    v.currentTime = t;
  });
}

/**
 * Frames of a clip at `fps`, each probed like a live camera frame: the full frame as the camera
 * gives it (not squared, like the game's frame pass) and square zoom crops for the faces.
 */
export async function probeVideo(src: string, fps = 5, maxFrames = 400): Promise<(ProbeImage & { t: number })[]> {
  // A blob URL: a fixture served without byte ranges cannot seek, and every frame would be the first.
  const blob = await (await fetch(src)).blob();
  const url = URL.createObjectURL(blob);
  // Headless Chrome has few media players: release each clip's before the next (see the end).
  const v = await loadVideo(url).catch(() => new Promise((r) => setTimeout(r, 1000)).then(() => loadVideo(url)));
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const ctx = c.getContext('2d')!;
  const out: (ProbeImage & { t: number })[] = [];
  for (let t = 0; t < v.duration && out.length < maxFrames; t += 1 / fps) {
    await seek(v, t);
    ctx.drawImage(v, 0, 0);
    out.push({ ...(await probeCanvas(c)), t: v.currentTime });
  }
  v.removeAttribute('src');
  v.load();
  URL.revokeObjectURL(url);
  return out;
}

export function installProbe(): void {
  // ?face=<model> swaps the face embedding model for a candidate from fixtures/models (compared by
  // scripts/realcheck.ts faces/clips). Human caches models per page, so one model per page load.
  const face = new URL(location.href).searchParams.get('face');
  if (face) (humanConfig.face as unknown as { insightface: { modelPath: string } }).insightface.modelPath = `/__fixtures/models/${face}.json`;
  (window as unknown as { __lzReal: unknown }).__lzReal = {
    ready: async () => {
      await probeHuman();
      const face = getHuman().models.stats().modelStats.filter((m) => m.name.startsWith('insightface') && m.loaded).map((m) => m.name);
      // Where the crop timings come from: the TF.js backend and the GPU (or software renderer) behind it.
      const gl = document.createElement('canvas').getContext('webgl');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      const gpu = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'no webgl';
      return `${getHuman().version} ${face.join(',')} on ${getHuman().tf.getBackend()} (${gpu})`;
    },
    probeImage,
    probeVideo,
    probeFrame,
  };
}
