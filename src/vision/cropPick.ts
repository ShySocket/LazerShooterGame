import { MAX_YAW_DEG, MIN_FACE_PX, SCAN_CALIB } from './calibration';
import { iou, type NBox } from './geometry';

/**
 * Which magnified crop, if any, is the detected face: the game's gates for a usable face (frameOps.ts
 * cropFaces: valid embedding, score, yaw, size) plus the scan's rule that the crop must overlap the
 * detected box, so a neighbour's face inside the crop is never taken; the centre-nearest of those.
 */
export function pickOwnCrop<T extends { box: NBox; score: number; yaw: number; valid: boolean }>(crops: T[], detected: NBox, width: number, height: number): T | null {
  const centre = (b: NBox) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
  const [fx, fy] = centre(detected);
  const ok = crops.filter((c) => c.valid && c.score >= SCAN_CALIB.minFaceScore && c.yaw <= MAX_YAW_DEG && Math.min(c.box[2] * width, c.box[3] * height) >= MIN_FACE_PX && iou(c.box, detected) >= SCAN_CALIB.minCropOverlap);
  ok.sort((a, b) => Math.hypot(centre(a.box)[0] - fx, centre(a.box)[1] - fy) - Math.hypot(centre(b.box)[0] - fx, centre(b.box)[1] - fy));
  return ok[0] ?? null;
}
