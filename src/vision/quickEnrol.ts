import { BODY_MODEL, type BodyProps, type OutfitSig, type Profile } from '../types';
import { averageProps, bodyProportions, FrameSampler, outfitSignature } from './clothing';
import { compactEmbedding, configurePass, FACE_MODEL, FACE_SAMPLES, faceYawDeg, isValidEmbedding, loadHuman, withHumanSession } from './human';
import { SCAN_CALIB } from './calibration';
import { pickOwnCrop } from './cropPick';
import { buildDetections } from './tracker';
import { toNBox } from './geometry';
import { faceRegion, ZoomPass } from './zoom';

export interface QuickEnrolResult {
  profile: Profile;
  /** Frames that gave a usable face embedding, out of the frames given. */
  faces: number;
  frames: number;
  /** Whether an outfit could be sampled (it needs the hips in frame). */
  outfit: boolean;
}

/**
 * Enrol the largest person in a handful of camera frames: face embeddings from the game's square
 * zoom crops and the outfit from the clothing sampler the scan uses. Practice targets (a friend, a
 * TV, a photo) are added this way from the rear camera, and the real-vision browser test enrols its
 * clips the same way. It stands in for the eight-angle head-turn scan, so a target enrolled like
 * this is only as good as the angles those frames happened to show.
 */
export async function enrolFromCanvases(canvases: HTMLCanvasElement[], fallbackOutfit?: Profile['outfit']): Promise<QuickEnrolResult> {
  const human = await loadHuman();
  const zoom = new ZoomPass();
  const sampler = new FrameSampler();
  const faces: number[][] = [];
  const outfits: OutfitSig[] = [];
  const props: BodyProps[] = [];
  for (const canvas of canvases) {
    await withHumanSession(async () => {
      configurePass(human, 'frame');
      const res = await human.detect(canvas);
      const main = buildDetections(res.body, res.face)
        .filter((d) => d.face && !d.associationAmbiguous)
        .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
      if (!main?.face) return;
      // A weak detection gives no face sample, but its outfit and body ratios still count below.
      if (main.face.score >= SCAN_CALIB.minFaceScore) {
        const fb = toNBox(main.face.boxRaw);
        const crops = (await zoom.run(human, canvas, faceRegion(fb, canvas.width / canvas.height, 6))).map((c) => ({ ...c, score: c.face.score, yaw: faceYawDeg(c.face), valid: isValidEmbedding(c.face.embedding) }));
        const own = pickOwnCrop(crops, fb, canvas.width, canvas.height);
        if (own) faces.push(compactEmbedding(own.face.embedding!));
      }
      if (main.body) {
        const pixels = sampler.grab(canvas, 320);
        const sig = pixels ? outfitSignature(pixels, main.body) : null;
        if (sig) outfits.push(sig);
        const p = bodyProportions(main.body);
        if (p) props.push(p);
      }
    });
  }
  if (faces.length === 0) throw new Error('No face found. Get closer, make sure the face is lit and turned towards you.');
  // Eight samples spread over the frames, as the scan keeps eight angles (repeats when fewer).
  const face = Array.from({ length: FACE_SAMPLES }, (_, i) => faces[Math.floor((i * faces.length) / FACE_SAMPLES)]);
  // Without the hips in frame no outfit can be sampled: the caller's stand-in, else an empty one.
  const sampled = outfits[Math.floor(outfits.length / 2)];
  const outfit = sampled ? { front: sampled, back: sampled } : (fallbackOutfit ?? { front: { top: [] }, back: { top: [] } });
  return {
    profile: { faceModel: FACE_MODEL, face, outfit, body: averageProps(props), bodyModel: BODY_MODEL },
    faces: faces.length,
    frames: canvases.length,
    outfit: Boolean(sampled),
  };
}

/** Copy the current video frame into a new canvas at its native size. */
export function grabFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (!video.videoWidth || !video.videoHeight) return null;
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d')!.drawImage(video, 0, 0);
  return c;
}
