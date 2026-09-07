import { useEffect, useRef, type RefObject } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { loadHuman } from '../vision/human';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs Human on every frame while active, sequentially so frames never pile up. */
export function useVisionLoop(
  video: RefObject<HTMLVideoElement | null>,
  active: boolean,
  onFrame: (res: Result, human: Human) => void,
): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  useEffect(() => {
    if (!active) return;
    let running = true;
    (async () => {
      let human: Human;
      try {
        human = await loadHuman();
      } catch (e) {
        console.warn('vision models unavailable', e);
        return;
      }
      while (running) {
        const v = video.current;
        if (!v || v.readyState < 2 || v.videoWidth === 0) {
          await sleep(60);
          continue;
        }
        let res: Result | null = null;
        try {
          res = await human.detect(v);
        } catch (e) {
          console.warn('detect failed', e);
          await sleep(200);
          continue;
        }
        if (!running) break;
        cb.current(res, human);
        await new Promise(requestAnimationFrame);
      }
    })();
    return () => {
      running = false;
    };
  }, [active, video]);
}
