import { useEffect, useRef, type RefObject } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { configurePass, loadHuman, withHumanSession } from '../vision/human';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VisionFrame {
  /** The exact camera pixels used for this result, stable until the handler finishes. */
  frame: HTMLCanvasElement;
  capturedAt: number;
  /** False after camera replacement, shutdown, or effect cancellation. Check again after awaits. */
  isCurrent: () => boolean;
}

/** Runs one frame and all its follow-up crops exclusively against the shared Human instance. */
export function useVisionLoop(
  video: RefObject<HTMLVideoElement | null>,
  active: boolean,
  onFrame: (res: Result, human: Human, context: VisionFrame) => void | Promise<void>,
): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  useEffect(() => {
    if (!active) return;
    let running = true;
    const frame = document.createElement('canvas');
    const ctx = frame.getContext('2d');
    if (!ctx) return;
    (async () => {
      let human: Human;
      try {
        human = await loadHuman();
      } catch (e) {
        console.warn('vision models unavailable', e);
        return;
      }
      let lastTime = -1;
      let lastStream: HTMLVideoElement['srcObject'] = null;
      while (running) {
        try {
          await withHumanSession(async () => {
            if (!running) return;
            const v = video.current;
            if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight || v.paused || v.ended) return;
            const stream = v.srcObject;
            // Avoid collecting the same decoded camera frame repeatedly on fast devices.
            if (stream === lastStream && v.currentTime === lastTime) return;
            lastStream = stream;
            lastTime = v.currentTime;
            if (frame.width !== v.videoWidth) frame.width = v.videoWidth;
            if (frame.height !== v.videoHeight) frame.height = v.videoHeight;
            ctx.drawImage(v, 0, 0, frame.width, frame.height);
            const width = frame.width;
            const height = frame.height;
            const streamIsLive = () => !stream || !('getVideoTracks' in stream) || stream.getVideoTracks().some((track) => track.readyState === 'live');
            const context: VisionFrame = {
              frame,
              capturedAt: performance.now(),
              isCurrent: () => running && video.current === v && v.srcObject === stream && streamIsLive()
                && v.videoWidth === width && v.videoHeight === height && v.readyState >= 2 && !v.paused && !v.ended,
            };
            const handler = cb.current;
            configurePass(human, 'frame');
            const res = await human.detect(frame);
            if (res.error) throw new Error(res.error);
            if (!context.isCurrent()) return;
            await handler(res, human, context);
          });
        } catch (e) {
          console.warn('vision frame failed', e);
          await sleep(200);
        }
        // Yield so the page can paint, but never wait on requestAnimationFrame alone: an occluded but
        // visible document (a webview behind another pane, a PWA in split view) stalls it to 1 Hz while
        // timers keep running, and the loop would drop to one frame per second for no reason.
        if (running) await Promise.race([new Promise(requestAnimationFrame), sleep(40)]);
      }
    })();
    return () => {
      running = false;
    };
  }, [active, video]);
}
