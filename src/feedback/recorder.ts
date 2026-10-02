import { BODY_MODEL, UNKNOWN_ID, type BodyProps, type OutfitSig, type RoomSettings } from '../types';
import { faceOnOwnHead, faceOwner, type Detection, type Track } from '../vision/tracker';
import type { FaceObservation, FrameOps, FrameOutcome, OutfitObservation } from '../vision/pipeline';
import type { Candidate } from '../vision/scoring';
import { centredSimilarity, FACE_MODEL } from '../vision/embedding';
import { outfitSupports, outfitVetoed } from '../vision/scoring';
import { CALIBRATION_VERSION } from '../vision/calibration';
import { hasOutfit, profileOutfitMatch, propsSimilarity } from '../vision/clothing';
import type { NBox } from '../vision/geometry';
import { IdMap, round, roundBox, roundKey, SAMPLE_VERSION, type EvidenceSummary, type FrameSummary, type Pid, type ShotSample, type TrackSummary } from './sample';

declare const __APP_COMMIT__: string | undefined;

/** Frames kept before a tap. Twelve covers about 2.5 s on a slow phone, the whole identity memory. */
export const PRE_TAP_FRAMES = 12;
/** An outfit observation older than this no longer describes the track. */
const OUTFIT_MEMORY_MS = 4000;
/** A shot still open this long after its tap was never settled (the pipeline was invalidated mid-burst): drop it. */
const OPEN_SHOT_MAX_MS = 5000;

export interface RoundInfo {
  code: string;
  startAt: number;
  settings: RoomSettings;
  /** Every enrolled player in the round, including the shooter. */
  playerIds: string[];
  shooter: string;
}

export interface TapInfo {
  id: string;
  /** Clock of the vision frames (performance.now()) at the tap. */
  tapAt: number;
  /** Server clock at the tap, for the time into the round. */
  roundNow: number;
  kind: string;
  crosshair: NBox;
  /** Capture time of the newest finished frame at the tap, null without one. */
  frameT: number | null;
  frameAgeMs: number | null;
  allowanceMs: number | null;
  trackId: number | null;
  /** The nominated track as published at the tap, when there was one. */
  track: Track | null;
  width: number;
  height: number;
  periodMs: number;
  staleMs: number;
  burstMs: number;
  liveFaces: Record<string, number>;
  eligible: Iterable<string>;
}

export interface VerdictInfo {
  outcome: string;
  resolvedTo: string | null;
  via: string | null;
  resolveMs: number | null;
  zoom: boolean;
  /** The body under the dot at decision time, when any. */
  track: Track | null;
  settledBy: 'tap' | 'frame' | 'timer';
  /** Why it did not land (pipeline.ts ShotRefusal), when a body was under the dot. */
  refusal?: string | null;
}

interface OpenShot {
  tap: TapInfo;
  pre: FrameSummary[];
  after: FrameSummary[];
  target: ShotSample['target'];
  eligible: Pid[];
}

interface RawFrame {
  t: number;
  summary: Omit<FrameSummary, 't'>;
}

interface OutfitMemory {
  sig: OutfitSig | null;
  props: BodyProps | null;
  t: number;
}

const appCommit = (): string => (typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev');

/**
 * Watches the pipeline from the outside, through the frame ops the game already hands it, and keeps
 * enough of what it saw to explain any shot afterwards. Nothing here changes what the pipeline does.
 * The game calls startRound, wraps its ops per frame, reports each finished frame, and brackets every
 * FIRE press with beginShot and endShot; the sample that comes back is what the shooter may label.
 */
export class ShotRecorder {
  private round: (RoundInfo & { key: string; ids: IdMap }) | null = null;
  private ring: RawFrame[] = [];
  private open = new Map<string, OpenShot>();
  private outfits = new Map<number, OutfitMemory>();
  /** Observations captured by the wrapped ops for the frame in progress, by detection index. */
  private faces = new Map<number, FaceObservation[]>();
  private outfitObs = new Map<number, OutfitObservation>();

  startRound(info: RoundInfo): string {
    const key = roundKey(info.code, info.startAt);
    this.round = { ...info, key, ids: new IdMap(info.playerIds) };
    this.reset();
    return key;
  }

  endRound(): void {
    this.round = null;
    this.reset();
  }

  private reset(): void {
    this.ring = [];
    this.open.clear();
    this.outfits.clear();
    this.faces.clear();
    this.outfitObs.clear();
  }

  active(): boolean {
    return this.round !== null;
  }

  /** The pipeline was invalidated: any burst in flight will never settle, so its record is dropped. */
  abandonOpenShots(): string[] {
    const ids = [...this.open.keys()];
    this.open.clear();
    return ids;
  }

  roundKey(): string | null {
    return this.round?.key ?? null;
  }

  /** The real ids behind p0, p1, ... of the current round; stays on the phone. */
  ids(): string[] {
    return this.round?.ids.all() ?? [];
  }

  pid(id: string): Pid {
    return this.round ? this.round.ids.pid(id) : id;
  }

  /** Ops that also hand this recorder every face and outfit observation, by detection index. */
  wrapOps(ops: FrameOps, dets: Detection[]): FrameOps {
    this.faces.clear();
    this.outfitObs.clear();
    if (!this.round) return ops;
    const index = (d: Detection) => dets.indexOf(d);
    return {
      isCurrent: ops.isCurrent,
      sampleOutfit: ops.sampleOutfit
        ? (d) => {
            const obs = ops.sampleOutfit!(d);
            if (obs) this.outfitObs.set(index(d), obs);
            return obs;
          }
        : null,
      cropFaces: async (region, d) => {
        const faces = await ops.cropFaces(region, d);
        if (faces.length) this.faces.set(index(d), [...(this.faces.get(index(d)) ?? []), ...faces]);
        return faces;
      },
    };
  }

  /**
   * A frame finished. Summarises every track with the evidence it received, appends the summary to
   * the pre-tap ring and to every shot whose burst is still open. `candidates` must be the galleries
   * the pipeline scored this frame against: VisionPipeline.galleries() taken before processFrame, so
   * live-learned faces are included and a face learned during this very frame is not.
   */
  frameDone(outcome: FrameOutcome<unknown>, dets: Detection[], capturedAt: number, candidates: readonly Candidate[]): void {
    const r = this.round;
    if (!r) return;
    // Faces are attributed the way the pipeline does it (processFrame): crops in order, each crop's
    // faces grouped by the detection that uniquely owns them, a group of two teaches nothing, and an
    // owner that already learned from an earlier crop ignores later ones.
    const owned = new Map<number, FaceObservation>();
    for (const faces of this.faces.values()) {
      const groups = new Map<number, FaceObservation[]>();
      for (const f of faces) {
        const owner = faceOwner(f.box, dets);
        // As processFrame: on a body somebody may be hidden behind, only a face on its own head is its read.
        if (owner >= 0 && outcome.tracks[owner]?.hiding && !faceOnOwnHead(f.box, dets[owner])) continue;
        if (owner >= 0 && !owned.has(owner)) groups.set(owner, [...(groups.get(owner) ?? []), f]);
      }
      for (const [owner, matched] of groups) if (matched.length === 1) owned.set(owner, matched[0]);
    }
    for (const [i, obs] of this.outfitObs) {
      const t = outcome.tracks[i];
      if (t) this.outfits.set(t.id, { sig: obs.sig, props: obs.props, t: capturedAt });
    }
    for (const [id, m] of this.outfits) if (capturedAt - m.t > OUTFIT_MEMORY_MS) this.outfits.delete(id);

    const tracks: TrackSummary[] = outcome.tracks.map((t, i) => {
      const d = dets[i];
      const ev: EvidenceSummary = {};
      const face = owned.get(i);
      if (face) {
        // Which bar each player's face was judged at (pipeline.ts applyFace): the replay needs it to
        // re-derive this frame's read for the overlap/crowd rule.
        const corroborated = candidates.filter((c) => hasOutfit(c.profile.outfit) && outfitSupports(t, c.id, capturedAt)).map((c) => r.ids.pid(c.id));
        ev.face = {
          sims: this.gallerySims(face.embedding, candidates),
          meanSims: t.faceMean ? this.gallerySims(t.faceMean, candidates) : {},
          quality: round(face.quality, 2),
          ...(corroborated.length ? { corroborated } : {}),
        };
      }
      // An unreadable torso is not a sample (pipeline.ts): the game fused nothing from it, so nothing is
      // recorded for the replay to fuse (an empty match used to replay as a vote for a stranger).
      const outfit = this.outfitObs.get(i);
      if (outfit?.sig) {
        const match: Record<Pid, { sim: number; cov: number; thighs: boolean }> = {};
        const body: Record<Pid, number> = {};
        for (const c of candidates) {
          if (outfit.sig && c.profile.outfit) {
            const m = profileOutfitMatch(outfit.sig, c.profile.outfit);
            match[r.ids.pid(c.id)] = { sim: round(m.sim), cov: round(m.coverage), thighs: m.thighs };
          }
          if (outfit.props && c.profile.body && c.profile.bodyModel === BODY_MODEL) body[r.ids.pid(c.id)] = round(propsSimilarity(outfit.props, c.profile.body));
        }
        ev.outfit = { match, ...(Object.keys(body).length ? { body } : {}) };
      }
      return {
        id: t.id,
        box: roundBox(t.box),
        hit: roundBox(t.hit),
        belief: r.ids.record(t.claimed ?? t.belief, 2),
        via: t.via,
        conflict: Boolean(t.identityConflict),
        ambiguous: Boolean(d?.associationAmbiguous),
        faceSamples: t.faceSamples,
        faceAgeMs: t.lastFaceAt > 0 ? Math.round(capturedAt - t.lastFaceAt) : null,
        evidenceAgeMs: Number.isFinite(t.lastEvidenceAt) ? Math.round(capturedAt - t.lastEvidenceAt) : null,
        inSight: outcome.inSight?.id === t.id,
        vetoed: Object.keys(t.outfitVeto ?? {}).filter((id) => outfitVetoed(t, id, capturedAt)).map((id) => r.ids.pid(id)),
        clothingAgeMs: t.lastOutfitReadAt ? Math.round(capturedAt - t.lastOutfitReadAt) : null,
        unconfirmed: Boolean(t.unconfirmed),
        reacquiring: Boolean(t.reacquireAt),
        overlapping: Boolean(t.overlapping),
        hiding: Boolean(t.hiding),
        crowded: Boolean(t.crowded),
        freshFace: Boolean(face),
        ...ev,
      };
    });
    const summary = { tracks, bodies: dets.filter((d) => d.body).length, refusal: outcome.lockRefusal ?? null, lock: outcome.lock ? (outcome.lock.kind === 'unknown' ? 'unknown' : `${outcome.lock.kind}:${r.ids.pid(outcome.lock.id)}`) : null };
    this.ring.push({ t: capturedAt, summary });
    if (this.ring.length > PRE_TAP_FRAMES) this.ring.shift();
    for (const [id, shot] of this.open) {
      if (capturedAt - shot.tap.tapAt > OPEN_SHOT_MAX_MS) this.open.delete(id);
      else if (capturedAt >= shot.tap.tapAt) shot.after.push({ t: Math.round(capturedAt - shot.tap.tapAt), ...summary });
    }
    this.faces.clear();
    this.outfitObs.clear();
  }

  private gallerySims(emb: number[], candidates: readonly Candidate[]): Record<Pid, number> {
    const out: Record<Pid, number> = {};
    for (const c of candidates) {
      let best = -1;
      for (const f of c.profile.face ?? []) if (f.length === emb.length) best = Math.max(best, centredSimilarity(f, emb));
      out[this.round!.ids.pid(c.id)] = round(best);
    }
    return out;
  }

  /** FIRE was pressed. Freezes the frames seen so far under the shot id. */
  beginShot(tap: TapInfo): void {
    const r = this.round;
    if (!r) return;
    const pre = this.ring.map((f) => ({ t: Math.round(f.t - tap.tapAt), ...f.summary }));
    const t = tap.track;
    const outfit = t ? this.outfits.get(t.id) : undefined;
    const liveFaces: Record<Pid, number> = {};
    for (const [id, n] of Object.entries(tap.liveFaces)) liveFaces[r.ids.pid(id)] = n;
    const target: ShotSample['target'] = t
      ? {
          trackId: t.id,
          faceMean: t.faceMean ? t.faceMean.map((v) => round(v, 4)) : null,
          faceSamples: t.faceSamples,
          outfit: outfit?.sig ?? null,
          props: outfit?.props ?? null,
          liveFaces,
        }
      : null;
    this.open.set(tap.id, { tap, pre, after: [], target, eligible: [...tap.eligible].map((id) => r.ids.pid(id)) });
  }

  hasOpenShot(id: string): boolean {
    return this.open.has(id);
  }

  /** The verdict is in. Returns the finished sample, or null when the shot was never begun (practice, no round). */
  endShot(id: string, verdict: VerdictInfo): ShotSample | null {
    const r = this.round;
    const shot = this.open.get(id);
    this.open.delete(id);
    if (!r || !shot) return null;
    const { tap } = shot;
    const frames = [...shot.pre, ...shot.after];
    return {
      v: SAMPLE_VERSION,
      app: { commit: appCommit(), faceModel: FACE_MODEL, bodyModel: BODY_MODEL, calibration: CALIBRATION_VERSION, ua: typeof navigator === 'undefined' ? 'node' : navigator.userAgent.slice(0, 200) },
      round: {
        key: r.key,
        code: r.code,
        startAt: r.startAt,
        settings: r.settings,
        players: r.playerIds.length,
        shooter: r.ids.pid(r.shooter),
        eligible: shot.eligible,
      },
      device: {
        periodMs: Number.isFinite(tap.periodMs) ? Math.round(tap.periodMs) : null,
        staleMs: Math.round(tap.staleMs),
        burstMs: Math.round(tap.burstMs),
        width: tap.width,
        height: tap.height,
      },
      shot: {
        id,
        roundMs: Math.max(0, Math.round(tap.roundNow - r.startAt)),
        outcome: verdict.outcome,
        kind: tap.kind,
        resolvedTo: verdict.resolvedTo ? r.ids.pid(verdict.resolvedTo) : null,
        via: verdict.via,
        resolveMs: verdict.resolveMs,
        zoom: verdict.zoom,
        frameAgeMs: tap.frameAgeMs,
        allowanceMs: tap.allowanceMs,
        crosshair: roundBox(tap.crosshair),
        trackId: tap.trackId,
        decidedAtFrame: frames.length - 1,
        settledBy: verdict.settledBy,
        decisionTrackId: verdict.track?.id ?? null,
        decisionBelief: verdict.track ? r.ids.record(verdict.track.claimed ?? verdict.track.belief, 2) : null,
        refusal: verdict.refusal ?? null,
      },
      frames,
      target: shot.target,
    };
  }
}

export { UNKNOWN_ID };
