import { compactEmbedding, configurePass, faceYawDeg, getHuman, isValidEmbedding, loadHuman, withHumanSession } from '../vision/human';
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
  /** Signed pitch in degrees from the crop mesh, NaN when missing. */
  pitch: number;
  /** Unit embedding from the zoom crop (the only embedding source in the game), empty when none. */
  embedding: number[];
}

export interface ProbeImage {
  width: number;
  height: number;
  faces: ProbeFace[];
  bodies: number;
  ms: number;
}

const zoom = new ZoomPass();

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
  const human = await loadHuman();
  const t0 = performance.now();
  return withHumanSession(async () => {
    configurePass(human, 'frame');
    const res = await human.detect(canvas);
    const faces: ProbeFace[] = [];
    for (const f of res.face) {
      const fb = toNBox(f.boxRaw);
      const crops = await zoom.run(human, canvas, faceRegion(fb, canvas.width / canvas.height, 6));
      const own = crops
        .map((c) => ({ c, dist: Math.hypot(c.box[0] + c.box[2] / 2 - fb[0] - fb[2] / 2, c.box[1] + c.box[3] / 2 - fb[1] - fb[3] / 2) }))
        .filter((x) => x.dist < fb[3])
        .sort((a, b) => a.dist - b.dist)[0]?.c;
      const pitch = own?.face.rotation?.angle?.pitch;
      faces.push({
        box: fb,
        px: fb[3] * canvas.height,
        score: f.score,
        yaw: own ? faceYawDeg(own.face) : NaN,
        pitch: typeof pitch === 'number' ? (pitch * 180) / Math.PI : NaN,
        embedding: own && isValidEmbedding(own.face.embedding) ? compactEmbedding(own.face.embedding) : [],
      });
    }
    return { width: canvas.width, height: canvas.height, faces, bodies: res.body.length, ms: performance.now() - t0 };
  });
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
  const v = await loadVideo(url);
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
  URL.revokeObjectURL(url);
  return out;
}

export function installProbe(): void {
  (window as unknown as { __lzReal: unknown }).__lzReal = {
    ready: async () => {
      await loadHuman();
      return getHuman().version;
    },
    probeImage,
    probeVideo,
  };
}
