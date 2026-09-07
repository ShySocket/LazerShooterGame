import { useEffect, useMemo, useRef, useState } from 'react';

export type Facing = 'user' | 'environment';

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Owns one camera stream. The returned ref attaches the stream to whichever <video> is currently
 * mounted, so screens may unmount and remount the element (or mount it late) without losing the feed.
 */
export function useCamera(facing: Facing, enabled = true) {
  const elRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const attachRef = useRef<(v: HTMLVideoElement) => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useMemo(
    () => ({
      get current(): HTMLVideoElement | null {
        return elRef.current;
      },
      set current(v: HTMLVideoElement | null) {
        elRef.current = v;
        if (v && streamRef.current && v.srcObject !== streamRef.current) attachRef.current(v);
      },
    }),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setReady(false);
    setError(null);

    const attach = async (v: HTMLVideoElement) => {
      const stream = streamRef.current;
      if (!stream) return;
      try {
        v.srcObject = stream;
        v.muted = true;
        v.setAttribute('playsinline', 'true');
        if (v.readyState < 1) await new Promise<void>((res) => v.addEventListener('loadedmetadata', () => res(), { once: true }));
        await v.play();
        if (!cancelled && streamRef.current === stream) setReady(true);
      } catch (e) {
        if (!cancelled) setError(describe(e));
      }
    };
    attachRef.current = (v) => void attach(v);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (elRef.current) await attach(elRef.current);
      } catch (e) {
        if (!cancelled) setError(describe(e));
      }
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      attachRef.current = () => undefined;
      setReady(false);
    };
  }, [facing, enabled]);

  return { videoRef, ready, error };
}
