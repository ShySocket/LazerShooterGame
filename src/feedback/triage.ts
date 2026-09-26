import type { ShotSample } from './sample';

/** What one labelled shot says about the tracking. */
export type Verdict = 'right hit' | 'WRONG hit' | 'WRONG hit on a non-player' | 'right refusal' | 'miss: nobody under the dot' | 'miss: unclear' | 'miss: camera too slow' | 'miss: other';

const HIT_OUTCOMES = new Set(['hit', 'eliminated']);

/**
 * Compare the game's decision with the shooter's label (who was really under the dot). The label
 * comes from the practice aim selector or the post-round review card.
 */
export function triage(s: ShotSample): Verdict | null {
  const label = s.label;
  if (!label) return null;
  const hit = HIT_OUTCOMES.has(s.shot.outcome) && s.shot.resolvedTo !== null ? s.shot.resolvedTo : null;
  if (label.kind === 'none') return hit ? 'WRONG hit on a non-player' : 'right refusal';
  if (hit) return hit === label.target ? 'right hit' : 'WRONG hit';
  if (s.shot.trackId === null && s.shot.decisionTrackId === null) return 'miss: nobody under the dot';
  if (s.shot.outcome === 'unclear') return 'miss: unclear';
  if (/stale|camera/.test(s.shot.outcome)) return 'miss: camera too slow';
  return 'miss: other';
}

export interface TriageSummary {
  labelled: number;
  counts: Partial<Record<Verdict, number>>;
  /** Shots that must never happen, for a closer look. */
  wrong: { round: string; shot: string; verdict: Verdict; resolvedTo: string | null; label: string; belief: Record<string, number> | null }[];
  /** Hit rate on shots labelled with a player, and refusal rate on shots labelled "nobody". */
  hitRate: number | null;
  refusalRate: number | null;
}

export function summarise(samples: ShotSample[]): TriageSummary {
  const counts: Partial<Record<Verdict, number>> = {};
  const wrong: TriageSummary['wrong'] = [];
  let players = 0;
  let hits = 0;
  let nobody = 0;
  let refused = 0;
  for (const s of samples) {
    const v = triage(s);
    if (!v) continue;
    counts[v] = (counts[v] ?? 0) + 1;
    if (s.label!.kind === 'player') {
      players++;
      if (v === 'right hit') hits++;
    } else {
      nobody++;
      if (v === 'right refusal') refused++;
    }
    if (v.startsWith('WRONG')) wrong.push({ round: s.round.key, shot: s.shot.id, verdict: v, resolvedTo: s.shot.resolvedTo, label: s.label!.kind === 'player' ? s.label!.target : 'nobody', belief: s.shot.decisionBelief });
  }
  return { labelled: players + nobody, counts, wrong, hitRate: players ? hits / players : null, refusalRate: nobody ? refused / nobody : null };
}
