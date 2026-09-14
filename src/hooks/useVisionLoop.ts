import { useEffect, useRef, type RefObject } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { configurePass, loadHuman, withHumanSession } from '../vision/human';
import { visionProfile, waitForVideoFrame } from '../vision/frameClock';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A presented-frame timestamp older than this against the copy is not the copied frame's. */
const MAX_CAPTURE_SKEW_MS = 600;

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
      // The next frame is sampled only after this one is fully handled, and only once the video has
      // presented a new frame (requestVideoFrameCallback where the browser offers it): one frame in
      // flight, never a backlog, and a capture timestamp from the camera pipeline when available.
      let presented = await waitForVideoFrame(video.current);
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
            const copyStart = performance.now();
            ctx.drawImage(v, 0, 0, frame.width, frame.height);
            visionProfile.record('copy', performance.now() - copyStart);
            const width = frame.width;
            const height = frame.height;
            const streamIsLive = () => !stream || !('getVideoTracks' in stream) || stream.getVideoTracks().some((track) => track.readyState === 'live');
            // A capture time much older than the copy is a stale callback (the session was held by
            // another consumer, a paused tab resuming): the copy time is the honest stamp then.
            const capturedAt = presented.source !== 'sampled' && copyStart - presented.capturedAt < MAX_CAPTURE_SKEW_MS && presented.capturedAt <= copyStart ? presented.capturedAt : copyStart;
            const context: VisionFrame = {
              frame,
              capturedAt,
              isCurrent: () => running && video.current === v && v.srcObject === stream && streamIsLive()
                && v.videoWidth === width && v.videoHeight === height && v.readyState >= 2 && !v.paused && !v.ended,
            };
            const handler = cb.current;
            configurePass(human, 'frame');
            const detectStart = performance.now();
            const res = await human.detect(frame);
            visionProfile.record('detect', performance.now() - detectStart);
            if (res.error) throw new Error(res.error);
            if (!context.isCurrent()) return;
            const handlerStart = performance.now();
            await handler(res, human, context);
            visionProfile.record('handler', performance.now() - handlerStart);
            visionProfile.record('age', performance.now() - capturedAt);
          });
        } catch (e) {
          console.warn('vision frame failed', e);
          await sleep(200);
        }
        // Wait for the next presented frame; the fallback never waits on requestAnimationFrame alone,
        // because an occluded but visible document stalls it to 1 Hz while timers keep running.
        if (running) presented = await waitForVideoFrame(video.current);
      }
    })();
    return () => {
      running = false;
    };
  }, [active, video]);
}
