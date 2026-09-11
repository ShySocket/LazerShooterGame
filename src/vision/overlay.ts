import type { Track } from './tracker';
import type { Detection } from './tracker';
import { coverTransform, toDisplay, toNBox } from './geometry';

export interface OverlayFrame {
  dets: Detection[];
  tracks: Track[];
  vidW: number;
  vidH: number;
  labels?: Record<string, string>;
  colors?: Record<string, string>;
}

/** Debug drawing of bodies, faces, and current identity belief. */
export function drawOverlay(canvas: HTMLCanvasElement, frame: OverlayFrame, mirrored = false): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dispW = canvas.clientWidth;
  const dispH = canvas.clientHeight;
  if (canvas.width !== dispW || canvas.height !== dispH) {
    canvas.width = dispW;
    canvas.height = dispH;
  }
  ctx.clearRect(0, 0, dispW, dispH);
  const t = coverTransform(frame.vidW, frame.vidH, dispW, dispH);
  ctx.save();
  if (mirrored) {
    ctx.translate(dispW, 0);
    ctx.scale(-1, 1);
  }
  ctx.lineWidth = 2;
  ctx.font = '14px system-ui, sans-serif';
  frame.dets.forEach((d, i) => {
    const track = frame.tracks[i];
    const [x, y, w, h] = toDisplay(d.box, frame.vidW, frame.vidH, t);
    let label = `#${track?.id ?? '?'}`;
    let color = '#8892a6';
    if (track) {
      const best = Object.entries(track.belief).sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] > 0.2) {
        label = `${frame.labels?.[best[0]] ?? best[0]} ${(best[1] * 100).toFixed(0)}%`;
        color = frame.colors?.[best[0]] ?? '#ffd23b';
      }
      // Two bodies reading as the same player: neither can be shot until one pulls ahead.
      if (track.identityConflict) label += ' (dup)';
    }
    // Dashed box: this face or body could belong to more than one person, so it gathers no evidence.
    if (d.associationAmbiguous) {
      label = `#${track?.id ?? '?'} ambiguous`;
      color = '#8892a6';
      ctx.setLineDash([6, 4]);
    }
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    if (d.face) {
      const [fx, fy, fw, fh] = toDisplay(toNBox(d.face.boxRaw), frame.vidW, frame.vidH, t);
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(fx, fy, fw, fh);
    }
    ctx.save();
    if (mirrored) {
      ctx.translate(dispW, 0);
      ctx.scale(-1, 1);
    }
    const lx = mirrored ? dispW - x - w : x;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(lx, y - 18, ctx.measureText(label).width + 8, 18);
    ctx.fillStyle = color;
    ctx.fillText(label, lx + 4, y - 4);
    ctx.restore();
  });
  ctx.restore();
}
