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
  /** While the face is this fresh (and ahead by 0.3), clothing is only audited, not fused. */
  faceFreshMs: number;
  clothingAuditMs: number;
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
  faceFreshMs: 1500,
  clothingAuditMs: 1000,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

interface BeliefState {
  belief: Record<Pid, number>;
  lastEvidenceT: number;
  lastFaceT: number;
  lastClothT: number;
}

function top(belief: Record<Pid, number>): { id: Pid; score: number; margin: number } | null {
  const entries = Object.entries(belief).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return { id: entries[0][0], score: entries[0][1], margin: entries[0][1] - (entries[1]?.[1] ?? 0) };
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
  let conflict = false;
  for (let i = 0; i <= last; i++) {
    const frame = sample.frames[i];
    for (const t of frame.tracks) {
      let s = states.get(t.id);
      if (!s) {
        s = { belief: {}, lastEvidenceT: -Infinity, lastFaceT: -Infinity, lastClothT: -Infinity };
        states.set(t.id, s);
      }
      if (Number.isFinite(s.lastEvidenceT) && frame.t - s.lastEvidenceT > p.identityTtlMs) s.belief = {};
      if (t.ambiguous) continue;
      // Same order and gates as processFrame: clothing first, fused only while the face is not
      // carrying the identity (otherwise it is an audit that fuses nothing), then the face crops.
      if (t.outfit) {
        const current = top(s.belief);
        const faceFresh = Number.isFinite(s.lastFaceT) && frame.t - s.lastFaceT < p.faceFreshMs && (current?.margin ?? 0) >= 0.3;
        const audit = faceFresh && frame.t - s.lastClothT >= p.clothingAuditMs;
        s.lastClothT = frame.t;
        if (!faceFresh || audit) {
          const ev = audit ? null : combine(null, clothingEvidence(t.outfit.match, s.belief, p), t.outfit.body ?? null, p);
          if (ev) update(s, ev, p.clothAlpha, frame.t);
        }
      }
      if (t.face && Object.keys(t.face.meanSims ?? {}).length) {
        // A frame that strongly names somebody else restarts the belief (applyFace's reset).
        const current = top(s.belief);
        const raw = faceEvidence(t.face.sims ?? {}, t.face.quality, p);
        const best = top(raw);
        if (current && best && best.id !== current.id && best.score >= 0.8 && (raw[current.id] ?? 0) < 0.2) s.belief = {};
        const ev = combine(faceEvidence(t.face.meanSims, t.face.quality, p), null, null, p);
        if (ev) update(s, ev, p.faceAlpha, frame.t);
        s.lastFaceT = frame.t;
      }
      if (i === last && t.id === trackId) {
        decision = s;
        conflict = t.conflict;
      }
    }
  }
  if (!decision || trackId === null) return { resolved: null, top: null };
  const best = top(decision.belief);
  if (!best) return { resolved: null, top: null };
  const eligible = new Set(sample.round.eligible ?? []);
  const ok = !conflict && eligible.has(best.id) && best.score >= threshold && best.margin >= margin && best.margin > 0;
  return { resolved: ok ? best.id : null, top: best };
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
  return sample.shot.resolvedTo ?? null;
}

/**
 * The database stores neither nulls nor empty arrays and objects, so an exported sample comes back
 * with those fields missing. Put them back so the rest of the replay can rely on the type.
 */
export function normaliseSample(raw: ShotSample): ShotSample {
  const frames = (raw.frames ?? []).map((f) => ({
    t: f.t ?? 0,
    lock: f.lock ?? null,
    tracks: (f.tracks ?? []).map((t) => ({
      ...t,
      belief: t.belief ?? {},
      conflict: Boolean(t.conflict),
      ambiguous: Boolean(t.ambiguous),
      faceAgeMs: t.faceAgeMs ?? null,
      evidenceAgeMs: t.evidenceAgeMs ?? null,
      inSight: Boolean(t.inSight),
      ...(t.face ? { face: { sims: t.face.sims ?? {}, meanSims: t.face.meanSims ?? {}, quality: t.face.quality ?? 1 } } : {}),
      ...(t.outfit ? { outfit: { match: t.outfit.match ?? {}, ...(t.outfit.body ? { body: t.outfit.body } : {}) } } : {}),
    })),
  }));
  return {
    ...raw,
    round: { ...raw.round, eligible: raw.round.eligible ?? [] },
    shot: { ...raw.shot, resolvedTo: raw.shot.resolvedTo ?? null, trackId: raw.shot.trackId ?? null, decisionTrackId: raw.shot.decisionTrackId ?? null, decisionBelief: raw.shot.decisionBelief ?? null },
    frames,
    target: raw.target ?? null,
  };
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
  // `frames` may be absent in an export of a sample whose frames were all empty; `shot` and `round` never are.
  const isSample = (v: unknown): v is ShotSample => typeof v === 'object' && v !== null && 'shot' in v && 'round' in v && 'v' in v;
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || typeof v !== 'object' || v === null) return;
    if (isSample(v)) {
      out.push(normaliseSample(v));
      return;
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, depth + 1);
  };
  walk(data, 0);
  return out;
}
