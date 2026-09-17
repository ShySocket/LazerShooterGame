import type { Human } from '@vladmandic/human';
import type { FaceObservation, FrameOps } from './pipeline';
import { bodyProportions, outfitSignature, type FrameSampler } from './clothing';
import { faceQuality, faceYawDeg, isValidEmbedding, MAX_YAW_DEG, MIN_FACE_PX, unitEmbedding } from './embedding';
import { faceRegion, headRegion, type ZoomPass } from './zoom';
import { toNBox, type NBox } from './geometry';
import { visionProfile } from './frameClock';

export interface FrameSource {
  /** The immutable copy of this frame's camera pixels. */
  frame: HTMLCanvasElement;
  width: number;
  height: number;
  human: Human;
  zoom: ZoomPass;
  sampler: FrameSampler;
  isCurrent: () => boolean;
}

/**
 * The pipeline's per-frame operations for a real frame, shared by the game and the bench: one lazy
 * pixel readback for clothing, magnified face crops through the zoom pass, and the profile stages
 * (crops, clothing, tracking) recorded once `done()` is called after processFrame.
 */
export function makeFrameOps(src: FrameSource): { ops: FrameOps; done: () => void } {
  const aspect = src.width / src.height;
  let img: ImageData | null | undefined;
  let cropMs = 0;
  let clothingMs = 0;
  const start = performance.now();
  const ops: FrameOps = {
    // The pixel readback is paid once per frame, and only when some track still needs clothing evidence.
    sampleOutfit: (d) => {
      if (!d.body) return null;
      const t0 = performance.now();
      if (img === undefined) img = src.sampler.grab(src.frame);
      const obs = img ? { sig: outfitSignature(img, d.body), props: bodyProportions(d.body) } : null;
      clothingMs += performance.now() - t0;
      return obs;
    },
    cropFaces: async (_region, d): Promise<FaceObservation[]> => {
      const region: NBox = d.face ? faceRegion(toNBox(d.face.boxRaw), aspect) : d.body ? headRegion(d.body, d.box, aspect) : d.box;
      const t0 = performance.now();
      const faces = await src.zoom.run(src.human, src.frame, region);
      cropMs += performance.now() - t0;
      return faces
        .map((zf) => ({ zf, px: Math.min(zf.box[2] * src.width, zf.box[3] * src.height) }))
        .filter(({ zf, px }) => isValidEmbedding(zf.face.embedding) && zf.face.score >= 0.7 && faceYawDeg(zf.face) <= MAX_YAW_DEG && px >= MIN_FACE_PX)
        .map(({ zf, px }) => ({ box: zf.box, embedding: unitEmbedding(zf.face.embedding!), quality: faceQuality(px) }));
    },
    isCurrent: src.isCurrent,
  };
  const done = () => {
    visionProfile.record('crops', cropMs);
    visionProfile.record('clothing', clothingMs);
    visionProfile.record('tracking', Math.max(0, performance.now() - start - cropMs - clothingMs));
  };
  return { ops, done };
}
