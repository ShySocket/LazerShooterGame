import type { NBox } from '../vision/geometry';

/** Longest side of a kept frame. Enough to see who was under the dot, small enough for a phone to keep dozens. */
export const PHOTO_MAX_PX = 640;
const JPEG_QUALITY = 0.72;

/**
 * Keeps small copies of the last two finished camera frames, keyed by capture time. The vision loop
 * reuses one canvas for every frame, so the pixels a shot was decided on are gone by the time the
 * shooter taps unless somebody copied them. Two buffers cover the newest finished frame at any tap
 * while the frame after it is being drawn.
 */
export class FrameKeeper {
  private buffers: { canvas: HTMLCanvasElement; t: number }[] = [];

  keep(frame: HTMLCanvasElement, capturedAt: number): void {
    if (!frame.width || !frame.height) return;
    const scale = Math.min(1, PHOTO_MAX_PX / Math.max(frame.width, frame.height));
    const w = Math.round(frame.width * scale);
    const h = Math.round(frame.height * scale);
    let slot = this.buffers.length < 2 ? null : this.buffers.reduce((a, b) => (a.t <= b.t ? a : b));
    if (!slot) {
      slot = { canvas: document.createElement('canvas'), t: -Infinity };
      this.buffers.push(slot);
    }
    if (slot.canvas.width !== w) slot.canvas.width = w;
    if (slot.canvas.height !== h) slot.canvas.height = h;
    const ctx = slot.canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(frame, 0, 0, w, h);
    slot.t = capturedAt;
  }

  /** The kept frame captured at `capturedAt`, or null when it has already been replaced. */
  take(capturedAt: number): HTMLCanvasElement | null {
    return this.buffers.find((b) => b.t === capturedAt)?.canvas ?? null;
  }

  clear(): void {
    this.buffers = [];
  }
}

/**
 * The photo the shooter is shown: the frame with the crosshair drawn where it was, nothing else. No
 * boxes or names, so the answer says what the person saw, not what the phone believed.
 */
export function renderShotPhoto(frame: HTMLCanvasElement, crosshair: NBox): Promise<Blob | null> {
  const out = document.createElement('canvas');
  out.width = frame.width;
  out.height = frame.height;
  const ctx = out.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(frame, 0, 0);
  const [x, y, w, h] = [crosshair[0] * out.width, crosshair[1] * out.height, crosshair[2] * out.width, crosshair[3] * out.height];
  ctx.lineWidth = Math.max(2, out.width / 320);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2, Math.max(4, out.width / 120), 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,59,92,0.9)';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  return new Promise((resolve) => {
    try {
      out.toBlob((b) => resolve(b), 'image/jpeg', JPEG_QUALITY);
    } catch {
      resolve(null);
    }
  });
}
