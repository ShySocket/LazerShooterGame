/**
 * Frame timing for the vision loop: when to sample the next camera frame, what time to stamp it
 * with, and a running profile of where each frame's time goes.
 *
 *   camera ──▶ presented frame ──▶ copy ──▶ detect ──▶ crops ──▶ clothing ──▶ tracking ──▶ publish
 *              (rVFC or rAF)      ┊ copy ┊ detect ┊         handler                    ┊
 *              capturedAt         └──────────────── age at publish ─────────────────────┘
 *
 * The loop is serial: one frame is copied, detected and handled before the next is sampled, so at
 * most one frame is ever in flight and a slow phone never builds a backlog of ageing frames. What
 * this module adds is sampling on a *new* presented frame rather than whenever the loop happens to
 * spin, and a capture timestamp from the browser's video frame metadata where the platform offers it.
 */

export interface PresentedFrame {
  /** When the frame was captured or presented, in performance.now() time. */
  capturedAt: number;
  /** Which clock produced capturedAt. */
  source: 'capture' | 'presented' | 'sampled';
}

type VideoWithCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
};

/**
 * Resolve on the next new video frame. With requestVideoFrameCallback the promise settles when the
 * compositor receives a frame and carries the capture time the camera pipeline reported (falling
 * back to the presentation time). Without it, or when the video is not playing, it yields for one
 * animation frame or `fallbackMs`, whichever comes first, and stamps the sampling time: an occluded
 * but visible document stalls requestAnimationFrame to 1 Hz while timers keep running.
 */
export function waitForVideoFrame(video: HTMLVideoElement | null, fallbackMs = 40, now: () => number = () => performance.now()): Promise<PresentedFrame> {
  const v = video as VideoWithCallback | null;
  // A hidden document gets no presented frames and should not spin: wait for it to come back, with a
  // long safety timeout so a stuck 'hidden' state never wedges the loop.
  if (typeof document !== 'undefined' && document.hidden) {
    return new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        document.removeEventListener('visibilitychange', settle);
        clearTimeout(timer);
        resolve({ capturedAt: now(), source: 'sampled' });
      };
      document.addEventListener('visibilitychange', settle);
      const timer = setTimeout(settle, HIDDEN_POLL_MS);
    });
  }
  if (v && typeof v.requestVideoFrameCallback === 'function' && !v.paused && !v.ended && v.readyState >= 2) {
    return new Promise((resolve) => {
      let done = false;
      const settle = (frame: PresentedFrame) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(frame);
      };
      v.requestVideoFrameCallback!((_t, metadata) => {
        const capture = metadata.captureTime;
        if (typeof capture === 'number' && Number.isFinite(capture) && capture > 0) settle({ capturedAt: capture, source: 'capture' });
        else settle({ capturedAt: metadata.presentationTime, source: 'presented' });
      });
      // A callback that never fires (the track ended, the element was detached) must not hang the loop.
      const timer = setTimeout(() => settle({ capturedAt: now(), source: 'sampled' }), Math.max(fallbackMs * 10, 400));
    });
  }
  // A paused or ended video presents nothing: poll gently instead of spinning at the frame rate.
  const wait = v && (v.paused || v.ended) ? Math.max(fallbackMs, PAUSED_POLL_MS) : fallbackMs;
  return new Promise((resolve) => {
    let done = false;
    let raf = 0;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      resolve({ capturedAt: now(), source: 'sampled' });
    };
    if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(settle);
    const timer = setTimeout(settle, wait);
  });
}

/** How long a hidden document waits before re-checking, when no visibilitychange event arrives. */
const HIDDEN_POLL_MS = 1000;
/** How often a paused video is re-checked. */
const PAUSED_POLL_MS = 250;

export type ProfileStage = 'copy' | 'detect' | 'crops' | 'clothing' | 'tracking' | 'handler' | 'age';

export interface StageSummary {
  n: number;
  median: number;
  p95: number;
  max: number;
}

/** Rolling per-stage timings for the last `keep` frames, summarised as median, p95 and max. */
export class VisionProfile {
  private samples = new Map<ProfileStage, number[]>();
  constructor(private keep = 300) {}

  record(stage: ProfileStage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const list = this.samples.get(stage) ?? [];
    list.push(ms);
    if (list.length > this.keep) list.shift();
    this.samples.set(stage, list);
  }

  summary(): Partial<Record<ProfileStage, StageSummary>> {
    const out: Partial<Record<ProfileStage, StageSummary>> = {};
    for (const [stage, list] of this.samples) {
      if (!list.length) continue;
      const sorted = [...list].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      out[stage] = { n: sorted.length, median: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(sorted[sorted.length - 1]) };
    }
    return out;
  }

  /** One line for a bench readout: `copy 4 · detect 180/230 · crops 40/60 · age 260/320 ms (p50/p95)`. */
  line(): string {
    const s = this.summary();
    const stages: ProfileStage[] = ['copy', 'detect', 'crops', 'clothing', 'tracking', 'age'];
    const parts = stages.filter((k) => s[k]).map((k) => `${k} ${s[k]!.median}/${s[k]!.p95}`);
    return parts.length ? parts.join(' · ') + ' ms (p50/p95)' : 'no frames yet';
  }

  reset(): void {
    this.samples.clear();
  }
}

/** The app-wide profile; dev builds expose it on window.__lzVision.profile(). */
export const visionProfile = new VisionProfile();
