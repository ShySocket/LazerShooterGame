import { useCallback, useRef, type RefObject } from 'react';

type TorchTrack = Omit<MediaStreamTrack, 'getCapabilities'> & {
  getCapabilities?: () => MediaTrackCapabilities & { torch?: boolean };
};

/**
 * Pulses the rear camera flashlight using the stream already playing in the video element.
 * Works on Android Chrome. iPhone Safari exposes no torch control, so it silently does nothing there.
 */
export function useTorch(videoRef: RefObject<HTMLVideoElement | null>) {
  const busy = useRef(false);
  const unsupported = useRef<TorchTrack | null>(null);

  return useCallback(
    (ms = 120) => {
      const stream = videoRef.current?.srcObject;
      if (!(stream instanceof MediaStream)) return;
      const track = stream.getVideoTracks()[0] as TorchTrack | undefined;
      if (!track || busy.current || unsupported.current === track) return;
      if (track.getCapabilities && !track.getCapabilities().torch) {
        unsupported.current = track;
        return;
      }
      busy.current = true;
      const set = (torch: boolean) => track.applyConstraints({ advanced: [{ torch } as MediaTrackConstraintSet] });
      set(true)
        .then(() => new Promise((r) => setTimeout(r, ms)))
        .then(() => set(false))
        .catch(() => {
          unsupported.current = track;
        })
        .finally(() => {
          busy.current = false;
        });
    },
    [videoRef],
  );
}
