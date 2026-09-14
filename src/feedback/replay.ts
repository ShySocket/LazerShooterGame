import { UNKNOWN_PID, type Pid, type ShotLabel, type ShotSample, type TrackSummary } from './sample';

/**
 * Offline replay of labelled shot samples. A sample carries the raw similarities every track
 * received frame by frame, so the evidence fusion of src/vision/scoring.ts can be re-run here with
 * different calibration and the verdicts compared with what the shooters said. This is the loop
 * that turns feedback into threshold changes: wrong hits are weighted far above misses because a
 * wrong hit is the outcome the game must never produce.
 */
export interface ReplayParams {
  faceReject: number;
  faceAccept: number;
  wFace: number;
  wCloth: number;
  wBody: number;
  /** Outfit similarity below `clothFloor` is no evidence; `clothFloor + clothSpan` is full evidence. */
  clothFloor: number;
  clothSpan: number;
  strangerBase: number;
  faceAlpha: number;
  clothAlpha: number;
  /** Belief cap when no face has ever been seen. */
  noFaceCap: number;
  identityTtlMs: number;
  /** Null means "the round's own setting". */
  hitThreshold: number | null;
  hitMargin: number | null;
}

/** The values in src/vision as of this build; keep in step when those change. */
export const DEFAULT_PARAMS: ReplayParams = {
  faceReject: 0.25,
  faceAccept: 0.55,
  wFace: 0.6,
  wCloth: 0.3,
  wBody: 0.1,
  clothFloor: 0.45,
  clothSpan: 0.35,
  strangerBase: 0.95,
  faceAlpha: 0.45,
  clothAlpha: 0.35,
  noFaceCap: 0.85,
  identityTtlMs: 1500,
  hitThreshold: null,
  hitMargin: null,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface BeliefState {
  belief: Record<Pid, number>;
  lastEvidenceT: number;
  sawFace: boolean;
}

function faceEvidence(meanSims: Record<Pid, number>, quality: number, p: ReplayParams): Record<Pid, number> {
  const ev: Record<Pid, number> = {};
  const weight = 0.6 + 0.4 * clamp01(quality);
  let top = 0;
  for (const [id, s] of Object.entries(meanSims)) {
    ev[id] = clamp01((s - p.faceReject) / (p.faceAccept - p.faceReject));
    top = Math.max(top, ev[id]);
  }
  for (const id of Object.keys(ev)) ev[id] *= weight;
  ev[UNKNOWN_PID] = weight * clamp01(1 - top);
  return ev;
}

function clothingEvidence(match: NonNullable<TrackSummary['outfit']>['match'], established: Record<Pid, number>, p: ReplayParams): Record<Pid, number> {
  const ev: Record<Pid, number> = {};
  let top = 0;
  for (const [id, m] of Object.entries(match)) {
    const raw = clamp01((m.sim - p.clothFloor) / p.clothSpan);
    const factor = Math.min(m.thighs ? 1 : 0.55, 0.2 + 0.8 * m.cov);
    const scaled = raw * factor;
    ev[id] = Math.max(scaled, Math.min(established[id] ?? 0, raw));
    top = Math.max(top, scaled);
  }
  ev[UNKNOWN_PID] = clamp01(p.strangerBase - top);
  return ev;
}

function combine(face: Record<Pid, number> | null, cloth: Record<Pid, number> | null, body: Record<Pid, number> | null, p: ReplayParams): Record<Pid, number> | null {
  if (!face && !cloth) return null;
  const parts: { w: number; v: Record<Pid, number> }[] = [];
  if (face && Object.keys(face).length) parts.push({ w: p.wFace, v: face });
  if (cloth && Object.keys(cloth).length) parts.push({ w: p.wCloth, v: cloth });
  if (body && Object.keys(body).length) parts.push({ w: p.wBody, v: body });
  if (parts.length === 0) return null;
  const ids = new Set<Pid>();
  for (const part of parts) Object.keys(part.v).forEach((id) => ids.add(id));
  const den = parts.reduce((s, part) => s + part.w, 0);
  const cap = face ? 1 : p.noFaceCap;
  const out: Record<Pid, number> = {};
  for (const id of ids) {
    let num = 0;
    for (const part of parts) {
      const v = part.v[id];
      if (v === undefined) {
        if (id === UNKNOWN_PID && part.w === p.wBody) num += part.w * 0.5;
        continue;
      }
      num += part.w * v;
    }
    out[id] = cap * (num / den);
  }
  return out;
}

function update(state: BeliefState, ev: Record<Pid, number>, alpha: number, t: number): void {
  for (const id of new Set([...Object.keys(state.belief), ...Object.keys(ev)])) {
    const v = Number.isFinite(ev[id]) ? clamp01(ev[id]) : 0;
    state.belief[id] = (1 - alpha) * (state.belief[id] ?? 0) + alpha * v;
  }
  state.lastEvidenceT = t;
}

export interface Verdict {
  resolved: Pid | null;
  top: { id: Pid; score: number; margin: number } | null;
}

/** Re-run the fusion over the sample's frames and decide the shot the way resolveHit would. */
export function replayShot(sample: ShotSample, overrides: Partial<ReplayParams> = {}): Verdict {
  const p: ReplayParams = { ...DEFAULT_PARAMS, ...overrides };
  const threshold = p.hitThreshold ?? sample.round.settings.hitThreshold;
  const margin = p.hitMargin ?? sample.round.settings.hitMargin;
  const states = new Map<number, BeliefState>();
  const last = Math.min(sample.shot.decidedAtFrame, sample.frames.length - 1);
  const trackId = sample.shot.decisionTrackId ?? sample.shot.trackId;
  let decision: BeliefState | null = null;
  for (let i = 0; i <= last; i++) {
    const frame = sample.frames[i];
    for (const t of frame.tracks) {
      let s = states.get(t.id);
      if (!s) {
        s = { belief: {}, lastEvidenceT: -Infinity, sawFace: false };
        states.set(t.id, s);
      }
      if (Number.isFinite(s.lastEvidenceT) && frame.t - s.lastEvidenceT > p.identityTtlMs) s.belief = {};
      if (t.ambiguous) continue;
      // Same order as processFrame: clothing for the frame first, then the face crops.
      if (t.outfit) {
        const ce = clothingEvidence(t.outfit.match, s.belief, p);
        const ev = combine(null, ce, t.outfit.body ?? null, p);
        if (ev) update(s, ev, p.clothAlpha, frame.t);
      }
      if (t.face && Object.keys(t.face.meanSims).length) {
        s.sawFace = true;
        const ev = combine(faceEvidence(t.face.meanSims, t.face.quality, p), null, null, p);
        if (ev) update(s, ev, p.faceAlpha, frame.t);
      }
      if (i === last && t.id === trackId) decision = s;
    }
  }
  if (!decision || trackId === null) return { resolved: null, top: null };
  const entries = Object.entries(decision.belief).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { resolved: null, top: null };
  const [id, score] = entries[0];
  const m = score - (entries[1]?.[1] ?? 0);
  const top = { id, score, margin: m };
  const eligible = new Set(sample.round.eligible);
  const ok = eligible.has(id) && score >= threshold && m >= margin && m > 0;
  return { resolved: ok ? id : null, top };
}

export type Judgement = 'correct' | 'wrong' | 'miss';

/** How a verdict compares with what the shooter said. */
export function judge(label: ShotLabel, resolved: Pid | null): Judgement {
  if (label.kind === 'player') return resolved === label.target ? 'correct' : resolved ? 'wrong' : 'miss';
  return resolved ? 'wrong' : 'correct';
}

export interface Evaluation {
  n: number;
  correct: number;
  wrong: number;
  miss: number;
  /** wrong hits weigh WRONG_WEIGHT misses each; lower is better. */
  score: number;
}

export const WRONG_WEIGHT = 5;

export function evaluate(samples: ShotSample[], overrides: Partial<ReplayParams> = {}, verdictOf: (s: ShotSample) => Pid | null = (s) => replayShot(s, overrides).resolved): Evaluation {
  const e: Evaluation = { n: 0, correct: 0, wrong: 0, miss: 0, score: 0 };
  for (const s of samples) {
    if (!s.label) continue;
    e.n++;
    e[judge(s.label, verdictOf(s))]++;
  }
  e.score = e.wrong * WRONG_WEIGHT + e.miss;
  return e;
}

/** The verdict the game actually gave, from the sample's own record, for comparison with the replay. */
export function asPlayed(sample: ShotSample): Pid | null {
  return sample.shot.resolvedTo;
}

/** Share of samples where the replay under the current defaults agrees with what the game did. */
export function agreement(samples: ShotSample[]): number {
  if (samples.length === 0) return 1;
  let same = 0;
  for (const s of samples) if (replayShot(s).resolved === asPlayed(s)) same++;
  return same / samples.length;
}

export interface SweepRow {
  name: string;
  params: Partial<ReplayParams>;
  result: Evaluation;
}

/** One-at-a-time variations around the defaults: readable, and enough to see which knob moves the score. */
export function defaultSweep(): { name: string; params: Partial<ReplayParams> }[] {
  const rows: { name: string; params: Partial<ReplayParams> }[] = [{ name: 'defaults', params: {} }];
  for (const v of [0.4, 0.45, 0.55, 0.6]) rows.push({ name: `hitThreshold ${v}`, params: { hitThreshold: v } });
  for (const v of [0.1, 0.15, 0.25, 0.3]) rows.push({ name: `hitMargin ${v}`, params: { hitMargin: v } });
  for (const v of [0.45, 0.5, 0.6, 0.65]) rows.push({ name: `faceAccept ${v}`, params: { faceAccept: v } });
  for (const v of [0.2, 0.3]) rows.push({ name: `faceReject ${v}`, params: { faceReject: v } });
  for (const v of [0.4, 0.5]) rows.push({ name: `clothFloor ${v}`, params: { clothFloor: v } });
  for (const v of [0.35, 0.45]) rows.push({ name: `faceAlpha ${v}`, params: { faceAlpha: v } });
  return rows;
}

export function sweep(samples: ShotSample[], rows = defaultSweep()): SweepRow[] {
  return rows.map((r) => ({ ...r, result: evaluate(samples, r.params) })).sort((a, b) => a.result.score - b.result.score);
}

/** Every sample found in a database export, whatever level it was exported from. */
export function collectSamples(data: unknown): ShotSample[] {
  const out: ShotSample[] = [];
  const isSample = (v: unknown): v is ShotSample => typeof v === 'object' && v !== null && 'frames' in v && 'shot' in v && 'round' in v;
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || typeof v !== 'object' || v === null) return;
    if (isSample(v)) {
      out.push(v);
      return;
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, depth + 1);
  };
  walk(data, 0);
  return out;
}
