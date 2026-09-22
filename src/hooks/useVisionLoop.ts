import { useEffect, useRef, type RefObject } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { abandonHumanLoad, configurePass, loadHuman, withHumanSession, type HumanPass } from '../vision/human';
import { failureDecision } from '../vision/schedule';
import { visionProfile, waitForVideoFrame } from '../vision/frameClock';
import { isE2E } from '../e2e/hook';

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

export interface VisionLoopOptions {
  /** Which full-frame pass to run: 'frame' (faces and bodies, the game) or 'face' (face boxes only, the enrolment face stage). */
  pass?: Exclude<HumanPass, 'crop'>;
  /**
   * Detect on a copy no wider than this. The enrolment face stage uses it: a face at selfie distance
   * is hundreds of pixels wide, so a 1080p copy only costs time. Sizes the handler sees (res.width,
   * face boxes in pixels) are those of the copy. The game never sets it.
   */
  maxWidth?: number;
  /**
   * Called when frames keep failing (a lost WebGL context, a detector that throws every time). The
   * loop has already stopped and abandoned the models; the screen should show the failure with a
   * Retry that reloads them.
   */
  onFailure?: (error: unknown, consecutiveFailures: number) => void;
}

/** Runs one frame and all its follow-up crops exclusively against the shared Human instance. */
export function useVisionLoop(
  video: RefObject<HTMLVideoElement | null>,
  active: boolean,
  onFrame: (res: Result, human: Human, context: VisionFrame) => void | Promise<void>,
  options: VisionLoopOptions = {},
): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  // Read per frame, so a screen can change the pass between its stages without restarting the loop.
  const opts = useRef(options);
  opts.current = options;
  useEffect(() => {
    if (!active) return;
    if (isE2E()) return syntheticLoop(video, cb);
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
      let failures = 0;
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
            const vidW = v.videoWidth;
            const vidH = v.videoHeight;
            const maxWidth = opts.current.maxWidth;
            const scale = maxWidth && vidW > maxWidth ? maxWidth / vidW : 1;
            const copyW = Math.round(vidW * scale);
            const copyH = Math.round(vidH * scale);
            if (frame.width !== copyW) frame.width = copyW;
            if (frame.height !== copyH) frame.height = copyH;
            const copyStart = performance.now();
            ctx.drawImage(v, 0, 0, frame.width, frame.height);
            visionProfile.record('copy', performance.now() - copyStart);
            const streamIsLive = () => !stream || !('getVideoTracks' in stream) || stream.getVideoTracks().some((track) => track.readyState === 'live');
            // A capture time much older than the copy is a stale callback (the session was held by
            // another consumer, a paused tab resuming): the copy time is the honest stamp then.
            const capturedAt = presented.source !== 'sampled' && copyStart - presented.capturedAt < MAX_CAPTURE_SKEW_MS && presented.capturedAt <= copyStart ? presented.capturedAt : copyStart;
            const context: VisionFrame = {
              frame,
              capturedAt,
              isCurrent: () => running && video.current === v && v.srcObject === stream && streamIsLive()
                && v.videoWidth === vidW && v.videoHeight === vidH && v.readyState >= 2 && !v.paused && !v.ended,
            };
            const handler = cb.current;
            configurePass(human, opts.current.pass ?? 'frame');
            const detectStart = performance.now();
            const res = await human.detect(frame);
            visionProfile.record('detect', performance.now() - detectStart);
            if (res.error) throw new Error(res.error);
            if (!context.isCurrent()) return;
            const handlerStart = performance.now();
            await handler(res, human, context);
            visionProfile.record('handler', performance.now() - handlerStart);
            visionProfile.record('age', performance.now() - capturedAt);
            failures = 0;
          });
        } catch (e) {
          console.warn('vision frame failed', e);
          failures++;
          if (failureDecision(failures) === 'reset') {
            // A loop that fails every frame is dead (context lost, models broken): stop, drop the
            // models so the next load starts clean, and let the screen say so with a Retry.
            running = false;
            abandonHumanLoad();
            opts.current.onFailure?.(e, failures);
            return;
          }
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

/**
 * The browser test harness (?e2e, dev builds only) has a fake camera with nobody in it, so instead
 * of the models an empty detector result is handed to the frame handler every 50 ms while the page
 * is visible. Taps then go through the real fire path (fresh empty geometry is a MISS, a hidden page
 * or a reset pipeline is NO CAMERA LOCK) without loading 24 MB of models per simulated phone.
 */
function syntheticLoop(video: RefObject<HTMLVideoElement | null>, cb: { current: Parameters<typeof useVisionLoop>[2] }): () => void {
  let running = true;
  const frame = document.createElement('canvas');
  const tick = async () => {
    while (running) {
      const v = video.current;
      if (v && v.videoWidth && !document.hidden) {
        frame.width = v.videoWidth;
        frame.height = v.videoHeight;
        const capturedAt = performance.now();
        const res = { body: [], face: [], hand: [], gesture: [], object: [], width: v.videoWidth, height: v.videoHeight, timestamp: Date.now(), performance: {}, persons: [], canvas: null } as unknown as Result;
        const context: VisionFrame = { frame, capturedAt, isCurrent: () => running && video.current === v };
        try {
          await cb.current(res, null as unknown as Human, context);
        } catch (e) {
          console.warn('synthetic frame failed', e);
        }
      }
      await sleep(50);
    }
  };
  void tick();
  return () => {
    running = false;
  };
}
