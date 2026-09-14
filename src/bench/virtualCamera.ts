import type { NBox } from '../vision/geometry';

/**
 * A pretend phone camera: a portrait window that drifts and zooms over a still photo, with a little
 * hand shake, so the real detector, tracker, and recogniser can be exercised without other people
 * in the room. The window geometry is known, so where any photo point is on "screen" is known too.
 */
export const CAM_W = 720;
export const CAM_H = 1280;

export interface Window {
  /** Photo-space rectangle currently shown, in pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Motion {
  /** Seconds for one left-right sweep. */
  panPeriodS: number;
  /**
   * Fraction of the photo height the window covers at its widest and tightest. Above 1 the window
   * is larger than the photo, which shrinks the person: a stand-in for distance.
   */
  zoomMin: number;
  zoomMax: number;
  /** Hand shake, in photo pixels. */
  shakePx: number;
}

export const DEFAULT_MOTION: Motion = { panPeriodS: 14, zoomMin: 0.7, zoomMax: 1, shakePx: 4 };
export const STILL_MOTION: Motion = { panPeriodS: 14, zoomMin: 1, zoomMax: 1, shakePx: 0 };

/**
 * Zoom levels of the range sweep. With the sample person filling the photo, a level z shows them at
 * about 1216 / z px of a 1280 px frame, which a phone camera sees at roughly 1.55 x z metres.
 */
export const RANGE_LEVELS = [1, 2, 3, 4, 5, 6];

/** A window that shows the whole photo at 1 / z scale, centred, with slight hand shake. */
export function rangeMotion(z: number): Motion {
  return { panPeriodS: 14, zoomMin: z, zoomMax: z, shakePx: 3 };
}

/** Approximate real distance in metres for a range level, from the person height it produces. */
export function rangeMetres(z: number): number {
  return Math.round(1.55 * z * 10) / 10;
}

export function windowAt(photoW: number, photoH: number, tSec: number, motion: Motion, rand: () => number = Math.random): Window {
  const zoom = motion.zoomMin + (motion.zoomMax - motion.zoomMin) * (0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / (motion.panPeriodS * 1.7)));
  let h = photoH * zoom;
  let w = (h * CAM_W) / CAM_H;
  const shake = () => (rand() * 2 - 1) * motion.shakePx;
  if (zoom > 1) {
    // Farther than the photo allows: the whole photo sits small in the middle of the frame.
    return { x: (photoW - w) / 2 + shake(), y: (photoH - h) / 2 + shake(), w, h };
  }
  if (w > photoW) {
    w = photoW;
    h = (w * CAM_H) / CAM_W;
  }
  const slack = photoW - w;
  const cx = w / 2 + slack * (0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / motion.panPeriodS));
  const x = Math.max(0, Math.min(photoW - w, cx - w / 2 + shake()));
  // Zooming in keeps the top of the photo in view, like a shooter who keeps heads in frame and lets
  // the feet go, rather than cutting the head off by zooming on the centre.
  const y = Math.max(0, Math.min(Math.max(0, photoH - h), (photoH - h) * 0.15 + shake()));
  return { x, y, w, h };
}

/** A photo-space box, normalised to the window. May lie partly or wholly outside 0..1. */
export function toCamera(box: NBox, win: Window): NBox {
  return [(box[0] - win.x) / win.w, (box[1] - win.y) / win.h, box[2] / win.w, box[3] / win.h];
}
