import { useEffect, useState } from 'react';
import { audioState, onAudioStateChange, type AudioState } from '../audio/sfx';

/** Live audio status so screens can warn when iOS has silenced the page. */
export function useAudioState(): AudioState {
  const [state, setState] = useState<AudioState>(audioState);
  useEffect(() => {
    const sync = () => setState(audioState());
    const off = onAudioStateChange(sync);
    const iv = window.setInterval(sync, 1000);
    return () => {
      off();
      window.clearInterval(iv);
    };
  }, []);
  return state;
}
