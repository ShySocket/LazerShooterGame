export interface ShotRecord {
  t: number;
  /** What happened: hit, miss, unclear, no target, shielded. */
  outcome: string;
  targetName?: string;
  targetId?: string;
  via?: string;
  /** Top beliefs on the track that was in the crosshair, best first. */
  beliefs: { id: string; name: string; score: number }[];
  /** Time from the tap to the decision. */
  resolveMs?: number;
  /** Whether the crosshair zoom pass contributed to this shot. */
  zoom?: boolean;
  /** For refused stale shots: how old a frame was allowed to be on this phone. */
  allowanceMs?: number;
}

/** Per-round record of every FIRE press on this phone, so a wrong hit can be explained afterwards. */
const shots: ShotRecord[] = [];

export const shotLog = {
  add(r: ShotRecord): void {
    shots.push(r);
    if (shots.length > 200) shots.shift();
  },
  all(): ShotRecord[] {
    return shots.slice();
  },
  clear(): void {
    shots.length = 0;
  },
};
