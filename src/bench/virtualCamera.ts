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
  /** Fraction of the photo height the window covers at its widest and tightest. */
  zoomMin: number;
  zoomMax: number;
  /** Hand shake, in photo pixels. */
  shakePx: number;
}

export const DEFAULT_MOTION: Motion = { panPeriodS: 14, zoomMin: 0.7, zoomMax: 1, shakePx: 4 };
export const STILL_MOTION: Motion = { panPeriodS: 14, zoomMin: 1, zoomMax: 1, shakePx: 0 };

export function windowAt(photoW: number, photoH: number, tSec: number, motion: Motion, rand: () => number = Math.random): Window {
  const zoom = motion.zoomMin + (motion.zoomMax - motion.zoomMin) * (0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / (motion.panPeriodS * 1.7)));
  let h = photoH * zoom;
  let w = (h * CAM_W) / CAM_H;
  if (w > photoW) {
    w = photoW;
    h = (w * CAM_H) / CAM_W;
  }
  const slack = photoW - w;
  const cx = w / 2 + slack * (0.5 + 0.5 * Math.sin((2 * Math.PI * tSec) / motion.panPeriodS));
  const shake = () => (rand() * 2 - 1) * motion.shakePx;
  const x = Math.max(0, Math.min(photoW - w, cx - w / 2 + shake()));
  const y = Math.max(0, Math.min(Math.max(0, photoH - h), (photoH - h) / 2 + shake()));
  return { x, y, w, h };
}

/** A photo-space box, normalised to the window. May lie partly or wholly outside 0..1. */
export function toCamera(box: NBox, win: Window): NBox {
  return [(box[0] - win.x) / win.w, (box[1] - win.y) / win.h, box[2] / win.w, box[3] / win.h];
}
