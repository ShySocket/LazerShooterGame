import { useEffect } from 'react';

/** Keeps the screen on while the game runs. Silently ignored where unsupported. */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* ignore */
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible' && !released) void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, [active]);
}
