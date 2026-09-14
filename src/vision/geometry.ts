/** Normalised box: x, y, w, h in 0..1 of the video frame. */
export type NBox = [number, number, number, number];

export function intersectArea(a: NBox, b: NBox): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

export function iou(a: NBox, b: NBox): number {
  const inter = intersectArea(a, b);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union <= 0 ? 0 : inter / union;
}

export function clampBox(b: NBox): NBox {
  const x = Math.max(0, b[0]);
  const y = Math.max(0, b[1]);
  const w = Math.min(1 - x, b[2] - (x - b[0]));
  const h = Math.min(1 - y, b[3] - (y - b[1]));
  return [x, y, Math.max(0, w), Math.max(0, h)];
}

export interface CoverTransform {
  scale: number;
  ox: number;
  oy: number;
}

/** How a video with object-fit: cover maps onto a display box. */
export function coverTransform(vidW: number, vidH: number, dispW: number, dispH: number): CoverTransform {
  const scale = Math.max(dispW / vidW, dispH / vidH);
  return { scale, ox: (dispW - vidW * scale) / 2, oy: (dispH - vidH * scale) / 2 };
}

/** Normalised video box to display pixels. */
export function toDisplay(b: NBox, vidW: number, vidH: number, t: CoverTransform): [number, number, number, number] {
  return [b[0] * vidW * t.scale + t.ox, b[1] * vidH * t.scale + t.oy, b[2] * vidW * t.scale, b[3] * vidH * t.scale];
}

/** The crosshair region, centred on screen, expressed in normalised video coordinates. */
export function crosshairRect(vidW: number, vidH: number, dispW: number, dispH: number, fracW = 0.42, fracH = 0.3): NBox {
  const t = coverTransform(vidW, vidH, dispW, dispH);
  const w = dispW * fracW;
  const h = dispH * fracH;
  const x = (dispW - w) / 2;
  const y = (dispH - h) / 2;
  return [(x - t.ox) / (vidW * t.scale), (y - t.oy) / (vidH * t.scale), w / (vidW * t.scale), h / (vidH * t.scale)];
}

/** Human reports boxes as plain number arrays; the tracker wants the 4-tuple. */
export function toNBox(b: number[]): NBox {
  return [b[0], b[1], b[2], b[3]];
}

/** Detector boxes jitter by a few percent of their size; a dot this close to another body's edge may really be on that body. */
import { AIM_EDGE_BAND } from './calibration';
export { AIM_EDGE_BAND };

/**
 * Aim at the centre dot. Exactly one box must contain it; any other box whose edge is within the
 * jitter band of the dot makes the aim ambiguous, so neither is selected: the detector cannot tell
 * whose pixels are under the dot there, and a wrong hit costs more than a refused one.
 */
export function indexInSight(boxes: NBox[], crosshair: NBox, hits?: NBox[]): number {
  const cx = crosshair[0] + crosshair[2] / 2;
  const cy = crosshair[1] + crosshair[3] / 2;
  let best = -1;
  let near = 0;
  for (let i = 0; i < boxes.length; i++) {
    const [x, y, w, h] = boxes[i];
    if (!(w > 0 && h > 0)) continue;
    if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
      if (best !== -1) return -1;
      best = i;
    } else {
      const gx = w * AIM_EDGE_BAND.x;
      const gy = h * AIM_EDGE_BAND.y;
      if (cx >= x - gx && cx <= x + w + gx && cy >= y - gy && cy <= y + h + gy) near++;
    }
  }
  if (near > 0 || best < 0) return -1;
  // The dot must also be on a part of that person the detector actually observed (head or torso).
  if (hits) {
    const [x, y, w, h] = hits[best];
    if (!(w > 0 && h > 0 && cx >= x && cx <= x + w && cy >= y && cy <= y + h)) return -1;
  }
  return best;
}
