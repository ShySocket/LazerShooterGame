import type { BodyResult, FaceResult, Human } from '@vladmandic/human';
import { clampBox, type NBox } from './geometry';
import { configurePass } from './human';

export interface ZoomFace {
  face: FaceResult;
  /** Face box mapped back to full-frame normalised coordinates. */
  box: NBox;
}

/**
 * Face pass on a magnified, square crop. Two reasons this is the only source of face embeddings:
 * Human squashes non-square inputs, so embeddings taken from a phone's portrait frame are badly
 * distorted (measured 0.45 similarity to the true vector versus 0.65 from a square crop of the same
 * face), and a distant face gets twice the pixels. Costs about 15 ms per crop, so callers limit
 * how many bodies get a crop per frame.
 */
export class ZoomPass {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;

  /**
   * @param side Fixed canvas size. A constant input size keeps the GPU texture allocations inside the
   *   vision library stable from frame to frame; varying sizes churn memory, which phones punish by
   *   reloading the page. The crop is scaled to fit, so a distant face is magnified and a close one
   *   is shrunk slightly, both well within what the face model expects.
   */
  constructor(private side = 512) {
    this.canvas.width = side;
    this.canvas.height = side;
  }

  async run(human: Human, video: HTMLVideoElement | HTMLCanvasElement, region: NBox): Promise<ZoomFace[]> {
    const vw = 'videoWidth' in video ? video.videoWidth : video.width;
    const vh = 'videoHeight' in video ? video.videoHeight : video.height;
    if (!vw || !vh) return [];
    // Grow the region a little so a face at the edge of the crosshair is not clipped.
    const r = clampBox([region[0] - region[2] * 0.25, region[1] - region[3] * 0.25, region[2] * 1.5, region[3] * 1.5]);
    const sw = r[2] * vw;
    const sh = r[3] * vh;
    if (sw < 8 || sh < 8) return [];
    const side = this.side;
    const scale = Math.min(side / sw, side / sh);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    // Square canvas: Human distorts non-square inputs, which ruins the embedding.
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, side, side);
    this.ctx.drawImage(video, r[0] * vw, r[1] * vh, sw, sh, 0, 0, w, h);
    let res;
    try {
      configurePass(human, 'crop');
      res = await human.detect(this.canvas);
    } finally {
      configurePass(human, 'frame');
    }
    // Face boxes come back relative to the square; map through the crop back to the full frame.
    const kx = side / w;
    const ky = side / h;
    return res.face.map((f) => ({
      face: f,
      box: [r[0] + f.boxRaw[0] * kx * r[2], r[1] + f.boxRaw[1] * ky * r[3], f.boxRaw[2] * kx * r[2], f.boxRaw[3] * ky * r[3]],
    }));
  }
}

/**
 * Where to look for the face of a body the face detector missed: around the head landmarks when
 * the pose has them, else the top of the body box. Far smaller than the whole body box, so the
 * face is magnified several times more, which is what finds a face at 5 to 8 m.
 */
export function headRegion(body: Pick<BodyResult, 'keypoints'>, box: NBox, aspect: number): NBox {
  const head = body.keypoints.filter((p) => ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar'].includes(p.part) && p.score >= 0.3 && [p.positionRaw[0], p.positionRaw[1]].every((v) => typeof v === 'number' && Number.isFinite(v)));
  if (head.length >= 2) {
    const cx = head.reduce((s, p) => s + p.positionRaw[0], 0) / head.length;
    const cy = head.reduce((s, p) => s + p.positionRaw[1], 0) / head.length;
    // Head height is about a third of shoulder width; take a generous square around it.
    const h = Math.max(box[3] * 0.22, box[2] * aspect * 0.6);
    const w = h / aspect;
    return [cx - w / 2, cy - h / 2, w, h];
  }
  return [box[0], box[1], box[2], Math.min(box[3], box[2] * aspect * 1.2)];
}

/**
 * A square region around a face box for the zoom pass. Six face-heights wide measured best on the
 * reference image (0.59 to 0.71 similarity across 2 to 8 m); tighter crops make the face too large
 * for the detector, wider ones give away the magnification.
 */
export function faceRegion(faceBox: NBox, aspect: number, factor = 6): NBox {
  const cx = faceBox[0] + faceBox[2] / 2;
  const cy = faceBox[1] + faceBox[3] / 2;
  // Keep the region square in pixels: width in normalised units is scaled by the frame aspect (w/h).
  const h = faceBox[3] * factor;
  const w = h / aspect;
  return [cx - w / 2, cy - h / 2, w, h];
}
