import { useEffect, useState } from 'react';
import { isHumanReady, loadHuman } from '../vision/human';
import { isE2E } from '../e2e/hook';

/** Kicks off model loading and reports progress text; a failed load can be retried (loadHuman forgets a failure). */
export function useHumanStatus(): { ready: boolean; status: string; failed: boolean; retry: () => void } {
  const [ready, setReady] = useState(isHumanReady());
  const [status, setStatus] = useState(isHumanReady() ? 'Ready' : 'Loading vision models');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // The browser test harness never loads the models: a fake camera has nobody to detect.
    if (isE2E()) {
      setReady(true);
      setStatus('Ready (e2e)');
      return;
    }
    let alive = true;
    setFailed(false);
    loadHuman((s) => alive && setStatus(s))
      .then(() => alive && setReady(true))
      .catch((e) => {
        if (!alive) return;
        setFailed(true);
        setStatus('Failed to load models: ' + (e instanceof Error ? e.message : String(e)) + '. Check the connection and tap Retry.');
      });
    return () => {
      alive = false;
    };
  }, [attempt]);
  return { ready, status, failed, retry: () => setAttempt((n) => n + 1) };
}
