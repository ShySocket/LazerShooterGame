import { useEffect, useState } from 'react';
import { isHumanReady, loadHuman } from '../vision/human';

/** Kicks off model loading and reports progress text. */
export function useHumanStatus(): { ready: boolean; status: string } {
  const [ready, setReady] = useState(isHumanReady());
  const [status, setStatus] = useState(isHumanReady() ? 'Ready' : 'Loading vision models');
  useEffect(() => {
    let alive = true;
    loadHuman((s) => alive && setStatus(s))
      .then(() => alive && setReady(true))
      .catch((e) => alive && setStatus('Failed to load models: ' + (e instanceof Error ? e.message : String(e))));
    return () => {
      alive = false;
    };
  }, []);
  return { ready, status };
}
