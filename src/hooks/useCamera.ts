import { useEffect, useRef, useState } from 'react';

export type Facing = 'user' | 'environment';

export function useCamera(facing: Facing, enabled = true) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setReady(false);
    setError(null);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current;
        if (!v) return;
        v.srcObject = stream;
        v.muted = true;
        v.setAttribute('playsinline', 'true');
        if (v.readyState < 1) await new Promise<void>((res) => v.addEventListener('loadedmetadata', () => res(), { once: true }));
        await v.play();
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setReady(false);
    };
  }, [facing, enabled]);

  return { videoRef, ready, error };
}
