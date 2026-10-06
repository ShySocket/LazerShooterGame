import { SCENARIOS, simulate, type Scenario, type SimFeedback } from './engine';
import { Rng } from './rng';
import { trimSample, type ProfilesSnapshot, type ShotLabel, type ShotSample } from '../../src/feedback/sample';
import { buildScene } from './world';

/**
 * Simulated rounds recorded the way phones upload shot feedback: one /feedback node with a round per
 * scenario and seed, every shot labelled from ground truth. The tuning loop (src/feedback/tune.ts)
 * is exercised on these before any real data exists; `poison` flips a share of the labels to a
 * wrong answer, the way a careless or malicious reviewer would, so the guardrails can be tested.
 */
export interface ExportOptions {
  seeds: number[];
  /** Scenario name substrings; empty means every scenario. */
  filter?: string[];
  /** Share of labels replaced by a wrong answer (0..1). */
  poison?: number;
  /** Seed of the poisoning draw. */
  poisonSeed?: number;
}

export interface FeedbackExport {
  rounds: Record<string, { profiles: ProfilesSnapshot; samples: Record<string, ShotSample> }>;
}

/** Four uppercase letters from a number, for a room code. */
const codeOf = (n: number): string => Array.from({ length: 4 }, (_, i) => String.fromCharCode(65 + (Math.floor(n / 26 ** i) % 26))).join('');

/** A wrong answer for a label: another player, or "should not count" for a player and a player for "none". */
export function poisonLabel(label: ShotLabel, pids: string[], rng: Rng): ShotLabel {
  if (label.kind === 'player') {
    const others = pids.filter((p) => p !== label.target);
    return others.length && rng.chance(0.5) ? { ...label, target: rng.pick(others) } : { kind: 'none', answeredAt: label.answeredAt, reviewMs: label.reviewMs };
  }
  return pids.length ? { kind: 'player', target: rng.pick(pids), answeredAt: label.answeredAt, reviewMs: label.reviewMs } : label;
}

export async function exportFeedback(opts: ExportOptions): Promise<FeedbackExport> {
  const out: FeedbackExport = { rounds: {} };
  const scenarios: Scenario[] = SCENARIOS.filter((s) => !opts.filter?.length || opts.filter.some((f) => s.name.includes(f)));
  const poisonRng = new Rng(opts.poisonSeed ?? 7);
  let n = 0;
  for (const scenario of scenarios) {
    for (const seed of opts.seeds) {
      const fb: SimFeedback = { code: codeOf(n), startAt: 1_700_000_000_000 + n * 60_000, samples: [] };
      n++;
      await simulate(scenario, { seed, feedback: fb });
      if (!fb.samples.length) continue;
      const pids = fb.pids ?? {};
      const scene = buildScene(new Rng(seed), scenario.people, 'me');
      const profiles: ProfilesSnapshot = {};
      for (const [id, profile] of Object.entries(scene.profiles)) if (pids[id]) profiles[pids[id]] = profile;
      const shooter = fb.samples[0].round.shooter;
      const opponents = Object.values(pids).filter((p) => p !== shooter);
      const samples: Record<string, ShotSample> = {};
      for (const s of fb.samples) {
        const label = opts.poison && s.label && poisonRng.chance(opts.poison) ? poisonLabel(s.label, opponents, poisonRng) : s.label;
        const sample = trimSample({ ...s, label });
        samples[sample.shot.id] = sample;
      }
      out.rounds[fb.samples[0].round.key] = { profiles, samples };
    }
  }
  return out;
}
