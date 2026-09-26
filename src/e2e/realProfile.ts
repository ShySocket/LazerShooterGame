import { BODY_MODEL, type BodyProps, type OutfitSig, type Profile } from '../types';
import { averageProps, bodyProportions, FrameSampler, outfitSignature } from '../vision/clothing';
import { compactEmbedding, configurePass, FACE_MODEL, FACE_SAMPLES, faceYawDeg, isValidEmbedding, loadHuman, MAX_YAW_DEG, withHumanSession } from '../vision/human';
import { buildDetections } from '../vision/tracker';
import { toNBox } from '../vision/geometry';
import { faceRegion, ZoomPass } from '../vision/zoom';

/**
 * A player's profile from real camera frames, for the real-vision browser test (`?e2e&vision`,
 * tests/e2e/realvision.spec.ts): the largest person in each frame, face embeddings from the game's
 * square zoom crops and the outfit from the same clothing sampler the scan uses. It stands in for
 * the head-turn scan, which a recorded clip cannot perform. DEV only, like the rest of src/e2e.
 */
export async function profileFromImages(urls: string[], fallbackOutfit?: Profile['outfit']): Promise<Profile> {
  const human = await loadHuman();
  const zoom = new ZoomPass();
  const sampler = new FrameSampler();
  const faces: number[][] = [];
  const outfits: OutfitSig[] = [];
  const props: BodyProps[] = [];
  for (const url of urls) {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('could not load ' + url));
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    await withHumanSession(async () => {
      configurePass(human, 'frame');
      const res = await human.detect(canvas);
      const main = buildDetections(res.body, res.face)
        .filter((d) => d.face && !d.associationAmbiguous)
        .sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
      if (!main?.face) return;
      const fb = toNBox(main.face.boxRaw);
      const own = (await zoom.run(human, canvas, faceRegion(fb, canvas.width / canvas.height, 6)))
        .filter((c) => isValidEmbedding(c.face.embedding) && faceYawDeg(c.face) <= MAX_YAW_DEG)
        .sort((a, b) => Math.hypot(a.box[0] - fb[0], a.box[1] - fb[1]) - Math.hypot(b.box[0] - fb[0], b.box[1] - fb[1]))[0];
      if (own) faces.push(compactEmbedding(own.face.embedding!));
      if (main.body) {
        const pixels = sampler.grab(canvas, 320);
        const sig = pixels ? outfitSignature(pixels, main.body) : null;
        if (sig) outfits.push(sig);
        const p = bodyProportions(main.body);
        if (p) props.push(p);
      }
    });
  }
  if (faces.length < FACE_SAMPLES) throw new Error(`only ${faces.length} usable faces in ${urls.length} frames`);
  // Eight faces spread over the frames, as the scan keeps eight angles.
  const step = faces.length / FACE_SAMPLES;
  const face = Array.from({ length: FACE_SAMPLES }, (_, i) => faces[Math.floor(i * step)]);
  // A waist-up clip has no hips in frame, so no outfit can be sampled (live frames neither): the
  // caller's distinct stand-in keeps the lobby from reading two empty outfits as the same clothes.
  const sampled = outfits[Math.floor(outfits.length / 2)];
  const outfit = sampled ? { front: sampled, back: sampled } : (fallbackOutfit ?? { front: { top: [] }, back: { top: [] } });
  return { faceModel: FACE_MODEL, face, outfit, body: averageProps(props), bodyModel: BODY_MODEL };
}
