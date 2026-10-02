import { UNKNOWN_PID, type Pid, type ShotLabel, type ShotSample, type TrackSummary } from './sample';
import { CLOTHING_AUDIT_MS, CLOTHING_BELIEF_ALPHA, CLOTHING_EVIDENCE, EVIDENCE_WEIGHTS, FACE_BELIEF_ALPHA, FACE_CALIB, FACE_FRESH_MS, FACE_ONLY_CALIB, IDENTITY_TTL_MS, OVERLAP_FACE_FRESH_MS, STRANGER_BASELINE } from '../vision/calibration';

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
  /** The bar a face read is judged at for a player whose own outfit does not back it on that body. */
  faceOnlyReject: number;
  faceOnlyAccept: number;
  /** During an overlap or in a crowded frame, the body's latest read must come from a frame this close to the deciding one. */
  overlapFaceFreshMs: number;
}

/**
 * The game's own values, read from src/vision/calibration.ts so a replay defaults to the calibration
 * this build decides with. The replay mirrors the evidence fusion, not the tracker or the
 * elapsed-time smoothing, so its verdicts approximate the game's rather than reproduce them.
 */
export const DEFAULT_PARAMS: ReplayParams = {
  faceReject: FACE_CALIB.reject,
  faceAccept: FACE_CALIB.accept,
  wFace: EVIDENCE_WEIGHTS.face,
  wCloth: EVIDENCE_WEIGHTS.cloth,
  wBody: EVIDENCE_WEIGHTS.body,
  clothFloor: CLOTHING_EVIDENCE.floor,
  clothSpan: CLOTHING_EVIDENCE.span,
  strangerBase: STRANGER_BASELINE,
  faceAlpha: FACE_BELIEF_ALPHA,
  clothAlpha: CLOTHING_BELIEF_ALPHA,
  noFaceCap: 0.85,
  identityTtlMs: IDENTITY_TTL_MS,
  hitThreshold: null,
  hitMargin: null,
  faceFreshMs: FACE_FRESH_MS,
  clothingAuditMs: CLOTHING_AUDIT_MS,
  faceOnlyReject: FACE_ONLY_CALIB.reject,
  faceOnlyAccept: FACE_ONLY_CALIB.accept,
  overlapFaceFreshMs: OVERLAP_FACE_FRESH_MS,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** One frame's face read on a body, on its own: who it names and by how much (pipeline.ts applyFace's lastRead). */
interface FaceRead {
  t: number;
  id: Pid;
  margin: number;
}

interface BeliefState {
  belief: Record<Pid, number>;
  lastEvidenceT: number;
  lastFaceT: number;
  lastClothT: number;
  /** The body's latest read; a belief reset does not forget it, as in the game. */
  read: FaceRead | null;
  /**
   * Whether the identity waits for agreeing evidence (Track.unconfirmed). On samples that record
   * `hiding` (v3) the replay keeps it itself, from the frames that set it and the evidence that clears
   * it under the replay's parameters; on older samples it is the recorded flag.
   */
  unconfirmed: boolean;
  /** The recorded `reacquiring` of this track's previous frame: its turning on marks a transition. */
  reacquiring: boolean;
}

function top(belief: Record<Pid, number>): { id: Pid; score: number; margin: number } | null {
  const entries = Object.entries(belief).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return { id: entries[0][0], score: entries[0][1], margin: entries[0][1] - (entries[1]?.[1] ?? 0) };
}

/**
 * Face similarity to evidence. With `corroborated`, a player outside it is judged at the face-only
 * bar, as scoring.ts faceEvidence does; without it everyone is judged at the normal bar.
 */
function faceEvidence(meanSims: Record<Pid, number>, quality: number, p: ReplayParams, corroborated?: Set<Pid>): Record<Pid, number> {
  const ev: Record<Pid, number> = {};
  const weight = 0.6 + 0.4 * clamp01(quality);
  let top = 0;
  for (const [id, s] of Object.entries(meanSims)) {
    const [reject, accept] = !corroborated || corroborated.has(id) ? [p.faceReject, p.faceAccept] : [p.faceOnlyReject, p.faceOnlyAccept];
    ev[id] = clamp01((s - reject) / (accept - reject));
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

/**
 * Blend one frame's evidence into the belief. With `confirm` (a sample whose unconfirmed flag the replay
 * keeps itself), evidence whose top names the belief's top before the update confirms the identity, as
 * scoring.ts updateBelief does; evidence for somebody else leaves it waiting.
 */
function update(state: BeliefState, ev: Record<Pid, number>, alpha: number, t: number, confirm?: Record<Pid, number>): void {
  if (confirm) {
    // As scoring.ts updateBelief: an empty confirm confirms nothing, whatever the belief.
    const seen = top(confirm)?.id;
    const believed = top(state.belief)?.id;
    if (seen !== undefined && (believed === undefined || seen === believed)) state.unconfirmed = false;
  }
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
  let gate: ShotSample['frames'][number]['tracks'][number] | null = null;
  for (let i = 0; i <= last; i++) {
    const frame = sample.frames[i];
    for (const t of frame.tracks) {
      // Samples that record `hiding` (v3) let the replay keep the unconfirmed flag itself, as the game
      // does: set on every frame of a presumed hidden partner, an overlap or an ambiguous association
      // and at a transition (`reacquiring` turning on), cleared by evidence that names the believed
      // player (on a hiding frame only this frame's own face read or outfit). A looser or stricter face
      // bar then confirms where the game would have confirmed with it; the recorded flag is the game's
      // calibration's verdict (review of 2026-10-01: under a looser bar it kept refusing hiding frames
      // the game would have confirmed, under-counting the wrong hits that bar would cause). What the
      // flag was before the sample's first frame of a track is unknown, so it starts as recorded there.
      const derived = typeof t.hiding === 'boolean';
      let s = states.get(t.id);
      if (!s) {
        s = { belief: {}, lastEvidenceT: -Infinity, lastFaceT: -Infinity, lastClothT: -Infinity, read: null, unconfirmed: Boolean(t.unconfirmed), reacquiring: Boolean(t.reacquiring) };
        states.set(t.id, s);
      }
      if (!derived) s.unconfirmed = Boolean(t.unconfirmed);
      else if (t.hiding || t.overlapping || t.ambiguous || (t.reacquiring && !s.reacquiring)) s.unconfirmed = true;
      s.reacquiring = Boolean(t.reacquiring);
      if (Number.isFinite(s.lastEvidenceT) && frame.t - s.lastEvidenceT > p.identityTtlMs) {
        s.belief = {};
        // resetIdentity, which an ambiguous body skips (pipeline.ts processFrame).
        if (derived && !t.ambiguous) s.unconfirmed = false;
      }
      if (t.ambiguous) continue;
      // Whose outfit backed a face on this body, as the game judged each player's face (v2): a player
      // outside it at the face-only bar, for this frame's read and for the running mean alike
      // (pipeline.ts applyFace). v1 samples do not say, and judge everyone at the normal bar.
      const corroborated = sample.v >= 2 ? new Set(t.face?.corroborated ?? []) : undefined;
      // Same order and gates as processFrame: clothing first, fused only while the face is not
      // carrying the identity (otherwise it is an audit that fuses nothing), then the face crops.
      if (t.outfit) {
        const current = top(s.belief);
        const faceFresh = Number.isFinite(s.lastFaceT) && frame.t - s.lastFaceT < p.faceFreshMs && (current?.margin ?? 0) >= 0.3;
        const audit = faceFresh && frame.t - s.lastClothT >= p.clothingAuditMs;
        s.lastClothT = frame.t;
        if (!faceFresh || audit) {
          // An unconfirmed identity is not propped up by its own old belief (pipeline.ts).
          const ev = audit ? null : combine(null, clothingEvidence(t.outfit.match, derived && s.unconfirmed ? {} : s.belief, p), t.outfit.body ?? null, p);
          // As pipeline.ts: on a body somebody may be hidden behind, the torso's pixels may be the partner's,
          // so an outfit read moves the belief but confirms nothing.
          if (ev) update(s, ev, p.clothAlpha, frame.t, derived ? (t.hiding ? {} : ev) : undefined);
        }
      }
      if (t.face && Object.keys(t.face.meanSims ?? {}).length) {
        // A frame that strongly names somebody else restarts the belief (applyFace's reset).
        const current = top(s.belief);
        const raw = faceEvidence(t.face.sims ?? {}, t.face.quality, p, corroborated);
        const best = top(raw);
        if (current && best && best.id !== current.id && best.score >= 0.8 && (raw[current.id] ?? 0) < 0.2) s.belief = {};
        const ev = combine(faceEvidence(t.face.meanSims, t.face.quality, p, corroborated), null, null, p);
        // While a partner may be hidden only this frame's own read confirms; otherwise the mean does.
        if (ev) update(s, ev, p.faceAlpha, frame.t, derived ? (t.hiding ? raw : ev) : undefined);
        s.lastFaceT = frame.t;
        // This frame's read on its own, at the bar the game judged each player's face at.
        const read = top(faceEvidence(t.face.sims ?? {}, t.face.quality, p, new Set(t.face.corroborated ?? [])));
        if (read) s.read = { t: frame.t, id: read.id, margin: read.margin };
      }
      if (i === last && t.id === trackId) {
        decision = s;
        conflict = t.conflict;
        gate = t;
      }
    }
  }
  if (!decision || trackId === null) return { resolved: null, top: null };
  const best = top(decision.belief);
  if (!best) return { resolved: null, top: null };
  const eligible = new Set(sample.round.eligible ?? []);
  // v2 samples carry the refusals the game applies on top of the belief: an identity not yet
  // confirmed or re-earned after a transition, a player the outfit rules out, and an overlap or a
  // crowded frame where the body's latest read, from a frame within overlapFaceFreshMs of the
  // deciding one, does not name the same player by the margin on its own (scoring.ts resolveHit).
  // v1 samples lack the fields and are judged on belief alone. The unconfirmed flag is the replay's
  // own on samples that record `hiding` (see above), the recorded one otherwise.
  const g = gate as ShotSample['frames'][number]['tracks'][number] | null;
  const decidedAt = sample.frames[last].t;
  const r = decision.read;
  const readNames = Boolean(r && decidedAt - r.t <= p.overlapFaceFreshMs && r.id === best.id && r.margin >= margin);
  const refused = Boolean(g && (decision.unconfirmed || g.reacquiring || g.vetoed?.includes(best.id) || ((g.overlapping || g.ambiguous || g.crowded) && !readNames)));
  const ok = !conflict && !refused && eligible.has(best.id) && best.score >= threshold && best.margin >= margin && best.margin > 0;
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
      ...(t.face ? { face: { sims: t.face.sims ?? {}, meanSims: t.face.meanSims ?? {}, quality: t.face.quality ?? 1, ...(t.face.corroborated ? { corroborated: t.face.corroborated } : {}) } } : {}),
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
