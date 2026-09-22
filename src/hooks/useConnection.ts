import { useEffect, useState } from 'react';
import { backend } from '../net';

/** True while this phone has a live link to the room server. Starts true so a fresh page does not flash OFFLINE. */
export function useConnection(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => backend.onConnection(setOnline), []);
  return online;
}
