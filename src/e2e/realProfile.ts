import type { Profile } from '../types';
import { FACE_MIN_SAMPLES } from '../vision/embedding';
import { enrolFromCanvases } from '../vision/quickEnrol';

/**
 * A player's profile from real frames for the real-vision browser test (`?e2e&vision`,
 * tests/e2e/realvision.spec.ts), through the same quick enrolment practice targets use. The test
 * expects a full set of distinct face samples, so fewer usable frames is an error here.
 */
export async function profileFromImages(urls: string[], fallbackOutfit?: Profile['outfit']): Promise<Profile> {
  const canvases: HTMLCanvasElement[] = [];
  for (const url of urls) {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('could not load ' + url));
      i.src = url;
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    canvases.push(c);
  }
  const r = await enrolFromCanvases(canvases, fallbackOutfit);
  if (r.faces < FACE_MIN_SAMPLES) throw new Error(`only ${r.faces} usable faces in ${urls.length} frames`);
  return r.profile;
}
