import { CLOTHING_INTERVAL_MS, SCHED_CALIB } from './calibration';

/**
 * How much optional work a frame may do, given how long frames are taking. A phone that is slow or
 * throttled keeps the crosshair target's crop (the shot depends on it) and sheds the rest, so the
 * frame period stops growing instead of collapsing into CAMERA TOO SLOW. Nothing here touches how a
 * shot is judged.
 */
export const isSlow = (periodMs: number, slowMs = SCHED_CALIB.slowPeriodMs): boolean => periodMs > slowMs;

/** Extra (non-target) face crops allowed this frame. */
export const cropBudget = (periodMs: number, base: number, slowMs = SCHED_CALIB.slowPeriodMs): number => (isSlow(periodMs, slowMs) ? 0 : base);

/** Whether clothing may be sampled now: at least every `interval`, and on a slow phone at most every other frame. */
export function clothingDue(periodMs: number, lastAt: number, now: number, interval = CLOTHING_INTERVAL_MS, slowMs = SCHED_CALIB.slowPeriodMs): boolean {
  const gap = isSlow(periodMs, slowMs) ? Math.max(interval, 2 * periodMs) : interval;
  return now - lastAt >= gap;
}

/** After this many consecutive failed frames the loop stops, reloads the models and tells the player. */
export const failureDecision = (consecutiveFailures: number, threshold = SCHED_CALIB.loopFailuresBeforeReset): 'continue' | 'reset' => (consecutiveFailures >= threshold ? 'reset' : 'continue');
