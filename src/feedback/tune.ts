import { asPlayed, DEFAULT_PARAMS, evaluate, judge, replayShot, type Evaluation, type ReplayParams } from './replay';
import { clopperPearsonUpper, clusterWrongBound } from './stats';
import type { ShotSample } from './sample';

/**
 * The guarded search the nightly tuning loop runs over labelled shot feedback (docs/tuning-loop.md).
 * It moves only the knobs the replay (replay.ts) mirrors faithfully, at most one grid step per knob
 * per run, and proposes a calibration only when the replay of every labelled shot keeps zero wrong
 * hits and the gain holds on rounds the search never saw. A wrong hit weighs above any number of
 * misses: the one proposal allowed without the usual data minimum is a tightening that removes a
 * wrong hit the current calibration replays. Labels that keep contradicting confident game verdicts
 * are treated as unreliable and stop every proposal, so a careless or hostile reviewer cannot steer
 * the calibration. Nothing here writes files; scripts/tune.ts does.
 */

export type TunableKey = 'faceReject' | 'faceAccept' | 'faceOnlyReject' | 'faceOnlyAccept' | 'wFace' | 'wCloth' | 'wBody' | 'clothFloor' | 'clothSpan' | 'strangerBase' | 'faceAlpha' | 'clothAlpha';

export interface Knob {
  key: TunableKey;
  step: number;
  min: number;
  max: number;
  /**
   * Which direction makes a hit harder: +1 when raising the value tightens, -1 when lowering it does.
   * A `tightenOnly` knob is moved only that way: the strict face-only bar never loosens automatically.
   */
  tighten: 1 | -1;
  tightenOnly?: boolean;
}

/**
 * Replay-faithful knobs. Not here, on purpose: hit threshold and margin (room settings the host
 * chooses), the time windows (they also drive the tracker, which the replay does not re-run), the
 * tracker and geometry gates, and FACE_MEAN (samples carry similarities, not embeddings).
 */
export const KNOBS: readonly Knob[] = [
  { key: 'faceReject', step: 0.02, min: 0.1, max: 0.5, tighten: 1 },
  { key: 'faceAccept', step: 0.02, min: 0.4, max: 0.85, tighten: 1 },
  { key: 'faceOnlyReject', step: 0.02, min: 0.5, max: 0.8, tighten: 1, tightenOnly: true },
  { key: 'faceOnlyAccept', step: 0.02, min: 0.8, max: 1, tighten: 1, tightenOnly: true },
  { key: 'wFace', step: 0.05, min: 0.3, max: 0.8, tighten: -1 },
  { key: 'wCloth', step: 0.05, min: 0.1, max: 0.5, tighten: -1 },
  { key: 'wBody', step: 0.05, min: 0, max: 0.2, tighten: -1 },
  { key: 'clothFloor', step: 0.02, min: 0.3, max: 0.6, tighten: 1 },
  { key: 'clothSpan', step: 0.02, min: 0.2, max: 0.5, tighten: 1 },
  { key: 'strangerBase', step: 0.02, min: 0.85, max: 1, tighten: 1 },
  { key: 'faceAlpha', step: 0.05, min: 0.2, max: 0.7, tighten: -1 },
  { key: 'clothAlpha', step: 0.05, min: 0.15, max: 0.6, tighten: -1 },
];

export const TUNE_GUARDS = {
  /** Labelled samples (v2 or later) needed before any loosening is considered. */
  minSamples: 200,
  /** Distinct rounds those samples must come from: one evening is not a calibration. */
  minRounds: 10,
  /** Share of samples where the replay at the current calibration matches the game; below it the replay is not trusted. */
  agreementFloor: 0.9,
  /** Share of rounds held out of the search to check the gain on. */
  holdoutShare: 0.25,
  /** Fewest misses the candidate must save over all data, and as a share of the labelled shots. */
  minMissGain: 5,
  minMissGainShare: 0.01,
  /** The hold-out must not get worse and must gain at least this many shots. */
  minHoldoutGain: 1,
  /**
   * A label contradicts the game when the game hit somebody with a clear belief and the label says
   * otherwise. Real wrong hits are rare; above this share the labels are unreliable and nothing is proposed.
   */
  contradictionCeiling: 0.05,
  /** A hit the game took with at least this top belief and margin counts as confident. */
  confidentScore: 0.75,
  confidentMargin: 0.35,
  /**
   * A tightening may cost at most this share of the labelled shots in new misses. A few poisoned
   * labels below the contradiction ceiling look like real wrong hits; this caps what they can take
   * from the game before a person looks.
   */
  maxTightenCostShare: 0.05,
};

export type Params = Record<TunableKey, number>;

export interface TuneEvidence {
  samples: number;
  rounds: number;
  trainRounds: number;
  holdoutRounds: number;
  agreement: number;
  contradictions: number;
  contradictionShare: number;
  current: { all: Evaluation; train: Evaluation; holdout: Evaluation; wrongPerHitUpper: number | null; roundWrongUpper: number | null };
  candidate: { all: Evaluation; train: Evaluation; holdout: Evaluation; wrongPerHitUpper: number | null; roundWrongUpper: number | null } | null;
}

export interface TuneResult {
  /** propose: loosen or rebalance for fewer misses; tighten: remove replayed wrong hits; none: keep the calibration. */
  decision: 'propose' | 'tighten' | 'none';
  current: Params;
  params: Params;
  /** Knobs that moved, old -> new. */
  changes: { key: TunableKey; from: number; to: number }[];
  evidence: TuneEvidence;
  /** Why the decision was taken, every guard that refused included. */
  reasons: string[];
}

export interface TuneOptions {
  guards?: Partial<typeof TUNE_GUARDS>;
  knobs?: readonly Knob[];
  /** Starting point; defaults to the build's calibration (replay.ts DEFAULT_PARAMS). */
  current?: Partial<ReplayParams>;
}

export const currentParams = (base: Partial<ReplayParams> = {}): Params => {
  const p = { ...DEFAULT_PARAMS, ...base };
  return Object.fromEntries(KNOBS.map((k) => [k.key, p[k.key]])) as Params;
};

const snap = (v: number) => Math.round(v * 1000) / 1000;

/** Deterministic round split: a round is held out by a hash of its key, so reruns agree. */
export function isHoldout(roundKey: string, share: number): boolean {
  let h = 2166136261;
  for (let i = 0; i < roundKey.length; i++) h = Math.imul(h ^ roundKey.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000 < share;
}

/** Whether a label contradicts a confident game verdict (see TUNE_GUARDS.contradictionCeiling). */
export function contradicts(s: ShotSample, g = TUNE_GUARDS): boolean {
  if (!s.label) return false;
  const played = asPlayed(s);
  if (!played || judge(s.label, played) !== 'wrong') return false;
  const belief = Object.values(s.shot.decisionBelief ?? {}).sort((a, b) => b - a);
  return (belief[0] ?? 0) >= g.confidentScore && (belief[0] ?? 0) - (belief[1] ?? 0) >= g.confidentMargin;
}

function bounds(samples: ShotSample[], params: Partial<ReplayParams>, e: Evaluation): { wrongPerHitUpper: number | null; roundWrongUpper: number | null } {
  const byRound = new Map<string, number>();
  for (const s of samples) {
    if (!s.label) continue;
    const w = judge(s.label, replayShot(s, params).resolved) === 'wrong' ? 1 : 0;
    byRound.set(s.round.key, (byRound.get(s.round.key) ?? 0) + w);
  }
  const accepted = e.correct + e.wrong;
  return { wrongPerHitUpper: accepted > 0 ? clopperPearsonUpper(e.wrong, accepted) : null, roundWrongUpper: clusterWrongBound(byRound.values()).upper };
}

/** Lexicographic: fewer wrong hits first, then fewer misses. */
const better = (a: Evaluation, b: Evaluation) => a.wrong < b.wrong || (a.wrong === b.wrong && a.miss < b.miss);

export function tune(all: ShotSample[], opts: TuneOptions = {}): TuneResult {
  const g = { ...TUNE_GUARDS, ...opts.guards };
  const knobs = opts.knobs ?? KNOBS;
  const labelled = all.filter((s) => s.label && s.v >= 2);
  const current = currentParams(opts.current);
  const rounds = new Set(labelled.map((s) => s.round.key));
  const train = labelled.filter((s) => !isHoldout(s.round.key, g.holdoutShare));
  const holdout = labelled.filter((s) => isHoldout(s.round.key, g.holdoutShare));
  const evalAll = (p: Params) => ({ all: evaluate(labelled, p), train: evaluate(train, p), holdout: evaluate(holdout, p) });
  const base = evalAll(current);
  const agree = labelled.length ? labelled.filter((s) => replayShot(s, current).resolved === asPlayed(s)).length / labelled.length : 1;
  const contradictions = labelled.filter((s) => contradicts(s, g)).length;
  const evidence: TuneEvidence = {
    samples: labelled.length,
    rounds: rounds.size,
    trainRounds: new Set(train.map((s) => s.round.key)).size,
    holdoutRounds: new Set(holdout.map((s) => s.round.key)).size,
    agreement: agree,
    contradictions,
    contradictionShare: labelled.length ? contradictions / labelled.length : 0,
    current: { ...base, ...bounds(labelled, current, base.all) },
    candidate: null,
  };
  const reasons: string[] = [];
  const none = (): TuneResult => ({ decision: 'none', current, params: current, changes: [], evidence, reasons });

  if (labelled.length === 0) {
    reasons.push('no labelled v2+ samples');
    return none();
  }
  if (evidence.contradictionShare > g.contradictionCeiling) {
    reasons.push(`labels unreliable: ${contradictions} of ${labelled.length} (${(evidence.contradictionShare * 100).toFixed(1)}%) contradict a confident game hit, above the ${(g.contradictionCeiling * 100).toFixed(0)}% ceiling; nothing is proposed until a person triages them`);
    return none();
  }
  if (agree < g.agreementFloor) {
    reasons.push(`replay agrees with the game on ${(agree * 100).toFixed(1)}% of shots, below the ${(g.agreementFloor * 100).toFixed(0)}% floor: the replay does not describe this build well enough to tune on`);
    return none();
  }

  // One grid step per knob per run, never past its bounds and never loosening a tighten-only knob.
  const moves = (p: Params, moved: Set<TunableKey>, onlyTighten: boolean): { key: TunableKey; value: number }[] => {
    const out: { key: TunableKey; value: number }[] = [];
    for (const k of knobs) {
      if (moved.has(k.key)) continue;
      for (const dir of [1, -1] as const) {
        const tightening = dir === k.tighten;
        if (!tightening && (k.tightenOnly || onlyTighten)) continue;
        const value = snap(p[k.key] + dir * k.step);
        if (value < k.min - 1e-9 || value > k.max + 1e-9) continue;
        const next = { ...p, [k.key]: value };
        if (next.faceAccept - next.faceReject < 0.1 || next.faceOnlyAccept - next.faceOnlyReject < 0.1) continue;
        out.push({ key: k.key, value });
      }
    }
    return out;
  };
  const changesOf = (p: Params) => knobs.filter((k) => p[k.key] !== current[k.key]).map((k) => ({ key: k.key, from: current[k.key], to: p[k.key] }));

  // Safety first: the current calibration replays a wrong hit. Tighten until none is left, whatever it costs in misses.
  if (base.all.wrong > 0) {
    let p = current;
    let e = base.all;
    const moved = new Set<TunableKey>();
    for (;;) {
      let best: { p: Params; e: Evaluation; key: TunableKey } | null = null;
      for (const m of moves(p, moved, true)) {
        const q = { ...p, [m.key]: m.value };
        const qe = evaluate(labelled, q);
        if (qe.wrong < e.wrong && (!best || better(qe, best.e))) best = { p: q, e: qe, key: m.key };
      }
      if (!best) break;
      p = best.p;
      e = best.e;
      moved.add(best.key);
      if (e.wrong === 0) break;
    }
    if (e.wrong >= base.all.wrong) {
      reasons.push(`current calibration replays ${base.all.wrong} wrong hit(s) and no one-step tightening of the tunable knobs removes any; a person must look (tracker, geometry or a model change)`);
      return none();
    }
    const cand = evalAll(p);
    evidence.candidate = { ...cand, ...bounds(labelled, p, cand.all) };
    const cost = cand.all.miss - base.all.miss;
    if (cost > Math.max(1, Math.ceil(g.maxTightenCostShare * labelled.length))) {
      reasons.push(`current calibration replays ${base.all.wrong} wrong hit(s), but the tightening that removes them (${[...moved].join(', ')}) costs ${cost} misses, more than ${(g.maxTightenCostShare * 100).toFixed(0)}% of shots; a person must look at those shots first`);
      return none();
    }
    reasons.push(`current calibration replays ${base.all.wrong} wrong hit(s); tightening ${[...moved].join(', ')} leaves ${cand.all.wrong} at a cost of ${cand.all.miss - base.all.miss} more misses`);
    if (cand.all.wrong > 0) reasons.push('wrong hits remain after one step per knob: the next run continues from the merged calibration');
    return { decision: 'tighten', current, params: p, changes: changesOf(p), evidence, reasons };
  }

  if (labelled.length < g.minSamples) reasons.push(`${labelled.length} labelled samples, fewer than the ${g.minSamples} a loosening needs`);
  if (rounds.size < g.minRounds) reasons.push(`${rounds.size} rounds, fewer than the ${g.minRounds} a loosening needs`);
  if (evidence.holdoutRounds === 0 || evidence.trainRounds === 0) reasons.push('no rounds on one side of the train/hold-out split');
  if (reasons.length) return none();

  // Greedy coordinate descent on the training rounds: take the single step that saves the most
  // misses with zero wrong hits, then the next knob, until no step helps.
  let p = current;
  let e = base.train;
  const moved = new Set<TunableKey>();
  for (;;) {
    let best: { p: Params; e: Evaluation; key: TunableKey } | null = null;
    for (const m of moves(p, moved, false)) {
      const q = { ...p, [m.key]: m.value };
      const qe = evaluate(train, q);
      if (qe.wrong === 0 && qe.miss < e.miss && (!best || better(qe, best.e))) best = { p: q, e: qe, key: m.key };
    }
    if (!best) break;
    p = best.p;
    e = best.e;
    moved.add(best.key);
  }
  if (moved.size === 0) {
    reasons.push('no single step of any tunable knob saves a miss on the training rounds without a wrong hit: the calibration is kept');
    return none();
  }
  const cand = evalAll(p);
  evidence.candidate = { ...cand, ...bounds(labelled, p, cand.all) };
  const gain = base.all.miss - cand.all.miss;
  const refusals: string[] = [];
  if (cand.all.wrong > 0) refusals.push(`the candidate replays ${cand.all.wrong} wrong hit(s) over all rounds`);
  if (cand.holdout.wrong > 0) refusals.push(`the candidate replays ${cand.holdout.wrong} wrong hit(s) on the hold-out`);
  if (base.holdout.miss - cand.holdout.miss < g.minHoldoutGain) refusals.push(`the hold-out gains ${base.holdout.miss - cand.holdout.miss} shot(s), fewer than ${g.minHoldoutGain}: the gain does not generalise`);
  if (gain < Math.max(g.minMissGain, Math.ceil(g.minMissGainShare * labelled.length))) refusals.push(`saves ${gain} misses, fewer than max(${g.minMissGain}, ${(g.minMissGainShare * 100).toFixed(0)}% of shots)`);
  const cw = evidence.candidate.wrongPerHitUpper;
  const bw = evidence.current.wrongPerHitUpper;
  if (cw !== null && bw !== null && cw > bw + 1e-12) refusals.push(`the wrong-hit upper bound per hit rises from ${bw.toFixed(4)} to ${cw.toFixed(4)}`);
  const cr = evidence.candidate.roundWrongUpper;
  const br = evidence.current.roundWrongUpper;
  if (cr !== null && br !== null && cr > br + 1e-12) refusals.push(`the per-round wrong-hit upper bound rises from ${br.toFixed(4)} to ${cr.toFixed(4)}`);
  if (refusals.length) {
    reasons.push(...refusals);
    return none();
  }
  reasons.push(`moving ${[...moved].join(', ')} one step saves ${gain} misses (${base.all.miss} -> ${cand.all.miss}) with 0 replayed wrong hits; hold-out ${base.holdout.miss} -> ${cand.holdout.miss} misses`);
  return { decision: 'propose', current, params: p, changes: changesOf(p), evidence, reasons };
}
