import type { Resolution } from '../vision/scoring';

export interface ShotRecord {
  t: number;
  /** What happened: hit, miss, unclear, no target, shielded. */
  outcome: string;
  targetName?: string;
  via?: string;
  /** Top beliefs on the track that was in the crosshair, best first. */
  beliefs: { id: string; name: string; score: number }[];
  top?: Resolution | null;
}

/** Per-round record of every FIRE press on this phone, so a wrong hit can be explained afterwards. */
const shots: ShotRecord[] = [];
const listeners = new Set<() => void>();

export const shotLog = {
  add(r: ShotRecord): void {
    shots.push(r);
    if (shots.length > 200) shots.shift();
    listeners.forEach((l) => l());
  },
  all(): ShotRecord[] {
    return shots.slice();
  },
  clear(): void {
    shots.length = 0;
    listeners.forEach((l) => l());
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
