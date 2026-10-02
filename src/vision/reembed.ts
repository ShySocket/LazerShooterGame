import type { NBox } from './geometry';
import { isValidEmbedding } from './embedding';

/** A face found in a crop: its full-frame box and what the detector said about it. */
export interface FoundFace {
  box: NBox;
  face: { embedding?: number[] | null; score?: number | null };
}

/**
 * Embed each face again from a crop of the geometry the templates were measured on (`regionOf`, the
 * game's faceRegion), keeping the re-crop's face nearest the found face's centre within half its
 * height. A face the re-crop does not find again is dropped rather than embedded at the finding
 * crop's scale: a head crop sized from the body box can fill most of the canvas with the face, and an
 * embedding at that scale names nobody, not even the person (2026-10-01 realcheck diagnosis).
 */
export async function reembedFaces<T extends FoundFace>(found: T[], crop: (region: NBox) => Promise<T[]>, regionOf: (box: NBox) => NBox): Promise<T[]> {
  const out: T[] = [];
  for (const zf of found) {
    if (!isValidEmbedding(zf.face.embedding) || (zf.face.score ?? 0) < 0.7) continue;
    const cx = zf.box[0] + zf.box[2] / 2;
    const cy = zf.box[1] + zf.box[3] / 2;
    const same = (await crop(regionOf(zf.box)))
      .map((g) => ({ g, dist: Math.hypot(g.box[0] + g.box[2] / 2 - cx, g.box[1] + g.box[3] / 2 - cy) }))
      .filter((x) => x.dist < zf.box[3] / 2)
      .sort((x, y) => x.dist - y.dist)[0];
    if (same) out.push(same.g);
  }
  return out;
}
