import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Facing = 'user' | 'environment';

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Turn the browser's camera errors into something a player can act on. */
function explain(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow the camera for this site in your browser settings, then tap Retry.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy in another app or tab (or the home-screen copy of this game). Close it, then tap Retry.';
    default:
      return describe(e);
  }
}

const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${what} did not respond for ${Math.round(ms / 1000)} s. Tap Retry.`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    );
  });

/**
 * Owns one camera stream. The returned ref attaches the stream to whichever <video> is currently
 * mounted, so screens may unmount and remount the element (or mount it late) without losing the feed.
 * Every way a phone camera can silently stay black (busy in another tab, Low Power Mode refusing
 * autoplay, a stream that never delivers metadata) ends in a readable error plus retry() instead.
 */
export function useCamera(facing: Facing, enabled = true) {
  const elRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const attachRef = useRef<(v: HTMLVideoElement) => void>(() => undefined);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

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
      const live = () => !cancelled && streamRef.current === stream;
      try {
        v.srcObject = stream;
        v.muted = true;
        v.setAttribute('playsinline', 'true');
        if (v.readyState < 1) {
          await withTimeout(new Promise<void>((res) => v.addEventListener('loadedmetadata', () => res(), { once: true })), 8000, 'The camera');
        }
        if (!live()) return;
        try {
          await v.play();
        } catch (e) {
          // iOS Low Power Mode refuses to autoplay even a muted video; the next tap anywhere starts it.
          if (!(e instanceof DOMException && e.name === 'NotAllowedError')) throw e;
          setError('Tap anywhere to start the camera (Low Power Mode stops it starting by itself).');
          await new Promise<void>((res) => {
            const once = () => {
              document.removeEventListener('pointerdown', once);
              res();
            };
            document.addEventListener('pointerdown', once);
          });
          if (!live()) return;
          await v.play();
          setError(null);
        }
        if (!live()) return;
        const track = stream.getVideoTracks()[0];
        // A muted track delivers no frames: another tab or app owns the camera, or the page is in the background.
        const onMute = () => {
          if (!live()) return;
          setReady(false);
          setError('The camera stopped sending frames. If another tab, app, or the home-screen copy of this game is using it, close that, then tap Retry.');
        };
        const onUnmute = () => {
          if (!live()) return;
          setError(null);
          setReady(true);
        };
        track?.addEventListener('mute', onMute);
        track?.addEventListener('unmute', onUnmute);
        track?.addEventListener('ended', onMute);
        if (track?.muted) onMute();
        else setReady(true);
      } catch (e) {
        if (!cancelled) setError(explain(e));
      }
    };
    attachRef.current = (v) => void attach(v);

    (async () => {
      // 1080p when the phone offers it: the detectors resize the frame to their own input size, so the
      // full-frame pass costs the same, but the magnified face crops read from the sharper frame and a
      // face keeps full weight (see FULL_QUALITY_FACE_PX) about 1.5x farther away. Phones that only
      // stream 720p (older iPhones) simply get 720p.
      const preferred: MediaStreamConstraints = { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } };
      const fallbacks: MediaStreamConstraints[] = [{ audio: false, video: { facingMode: facing } }, { audio: false, video: true }];
      let stream: MediaStream | null = null;
      let lastError: unknown = null;
      for (const constraints of [preferred, ...fallbacks]) {
        try {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot open the camera here. The page must be served over HTTPS.');
          const request = navigator.mediaDevices.getUserMedia(constraints);
          // A request that resolves only after the timeout below must not leave a live camera stream
          // running that nothing owns. The guard is armed in the catch path, after the timeout has
          // rejected, so it can never run against the stream this attempt adopts.
          try {
            stream = await withTimeout(request, 20000, 'The camera permission prompt');
          } catch (e) {
            request.then((late) => late.getTracks().forEach((t) => t.stop()), () => undefined);
            throw e;
          }
          break;
        } catch (e) {
          lastError = e;
          // A denied permission will not change by relaxing constraints; a busy or over-constrained camera might.
          if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
        }
        if (cancelled) return;
      }
      if (cancelled) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      if (!stream) {
        setError(explain(lastError));
        return;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      if (elRef.current) await attach(elRef.current);
    })();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      attachRef.current = () => undefined;
      setReady(false);
    };
  }, [facing, enabled, attempt]);

  return { videoRef, ready, error, retry };
}
