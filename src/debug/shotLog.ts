import { CALIBRATION_VERSION } from '../vision/calibration';

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
  /** Which set of thresholds decided this shot (src/vision/calibration.ts); filled in by add(). */
  calibration?: string;
  /** Face samples learned live this round per player at the time of the shot, so a hit decided by a learned sample is visible. */
  liveFaces?: Record<string, number>;
}

/** Per-round record of every FIRE press on this phone, so a wrong hit can be explained afterwards. */
const shots: ShotRecord[] = [];

export const shotLog = {
  add(r: ShotRecord): void {
    shots.push({ calibration: CALIBRATION_VERSION, ...r });
    if (shots.length > 200) shots.shift();
  },
  all(): ShotRecord[] {
    return shots.slice();
  },
  clear(): void {
    shots.length = 0;
  },
};
