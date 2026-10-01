import { useEffect, useState } from 'react';
import { abandonHumanLoad, isHumanReady, loadHuman, modelStats, REQUIRED_MODELS } from '../vision/human';
import { e2eStubsVision } from '../e2e/hook';
import { LOAD_CALIB } from '../vision/calibration';
import { isStalled, loadProgress, STALL_TEXT } from '../ui/advice';

/** Kicks off model loading and reports progress text; a failed load can be retried (loadHuman forgets a failure). */
export function useHumanStatus(): { ready: boolean; status: string; failed: boolean; retry: () => void; reportFailure: (error: unknown, count: number) => void } {
  const [ready, setReady] = useState(isHumanReady());
  const [status, setStatus] = useState(isHumanReady() ? 'Ready' : 'Loading vision models');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // The browser test harness never loads the models: a fake camera has nobody to detect.
    if (e2eStubsVision()) {
      setReady(true);
      setStatus('Ready (e2e)');
      return;
    }
    let alive = true;
    let done = isHumanReady();
    setFailed(false);
    // Progress from the model stats, and a stall watchdog: a download that makes no progress for
    // LOAD_CALIB.modelStallMs is abandoned and reported with a Retry instead of a black camera.
    let lastLoaded = -1;
    let lastProgressAt = performance.now();
    let warming = false;
    const poll = window.setInterval(() => {
      if (!alive || done) return;
      const p = loadProgress(modelStats(), REQUIRED_MODELS);
      if (p.loaded !== lastLoaded) {
        lastLoaded = p.loaded;
        lastProgressAt = performance.now();
      }
      if (!warming) setStatus(p.text);
      if (isStalled(performance.now() - lastProgressAt)) {
        done = true;
        abandonHumanLoad();
        setFailed(true);
        setStatus(STALL_TEXT);
      }
    }, LOAD_CALIB.progressPollMs);
    loadHuman((s) => {
      if (!alive || done) return;
      if (s === 'Warming up' || s === 'Ready') {
        warming = true;
        setStatus(s);
      }
    })
      .then(() => {
        if (!alive || done) return;
        done = true;
        setReady(true);
      })
      .catch((e) => {
        if (!alive || done) return;
        done = true;
        setFailed(true);
        setStatus('Failed to load models: ' + (e instanceof Error ? e.message : String(e)) + '. Check the connection and tap Retry.');
      });
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [attempt]);
  /** The vision loop gave up after repeated failures and dropped the models: show it, offer Retry. */
  const reportFailure = (error: unknown, count: number) => {
    setReady(false);
    setFailed(true);
    setStatus(`Camera processing failed ${count} times (${error instanceof Error ? error.message : String(error)}). Tap Retry to reload the models.`);
  };
  return { ready, status, failed, retry: () => setAttempt((n) => n + 1), reportFailure };
}
