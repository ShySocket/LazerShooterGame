import { useEffect, useMemo, useRef, useState } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { backend, MIN_PLAYERS } from '../net';
import { alivePlayers, enrolledPlayers, livesLabel, UNKNOWN_ID, type Player, type Room } from '../types';
import { useCamera } from '../hooks/useCamera';
import { useVisionLoop } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { useWakeLock } from '../hooks/useWakeLock';
import { useTorch } from '../hooks/useTorch';
import { Tracker, type Detection, type Track } from '../vision/tracker';
import { clampBox, crosshairRect, indexInSight, toNBox, type NBox } from '../vision/geometry';
import { bodyProportions, FrameSampler, outfitSignature } from '../vision/clothing';
import {
  assignIdentities,
  bestBelief,
  bodyEvidence,
  clothingEvidence,
  combineEvidence,
  faceEvidence,
  resolveHit,
  topBelief,
  updateBelief,
  updateFaceMean,
  type Candidate,
  type Resolution,
} from '../vision/scoring';
import { FACE_CALIB, FACE_MODEL, faceYawDeg, MAX_YAW_DEG, unitEmbedding, unitSimilarity } from '../vision/human';
import { faceRegion, ZoomPass } from '../vision/zoom';
import { shotLog } from '../debug/shotLog';
import { rangeTest } from '../debug/rangeTest';
import { drawOverlay } from '../vision/overlay';
import { haptic, sfx, unlockAudio, vibrate } from '../audio/sfx';
import { roundTo } from '../util/num';

interface Props {
  room: Room;
  me: Player;
  pid: string;
  onLeave: () => void;
}

interface Latest {
  dets: Detection[];
  tracks: Track[];
  vidW: number;
  vidH: number;
  t: number;
}

/** A shot that was not decidable at the tap; it waits for a few more frames of evidence. */
interface PendingShot {
  trackId: number;
  startedAt: number;
  deadline: number;
  framesLeft: number;
  zoom: boolean;
}

type Kind = 'info' | 'good' | 'warn' | 'bad';

/** A frame older than this is not trusted for a shot. */
const STALE_FRAME_MS = 800;
/** Clothing is only re-sampled for tracks whose face has not been seen this recently. */
const FACE_FRESH_MS = 1500;
/** Every Nth frame pays for the pixel readback that clothing sampling needs. */
const CLOTHING_EVERY = 3;
/** A borderline shot may wait this long, or this many frames, before it is called unclear. */
const BURST_MS = 300;
const BURST_FRAMES = 4;
/** Besides the crosshair target, this many other bodies get a face crop per frame, round-robin. */
const EXTRA_CROPS = 1;
const RANGE_DISTANCES = [2, 4, 6, 8];

export function Game({ room, me, pid, onLeave }: Props) {
  const isHost = room.hostId === pid;
  const settings = room.settings;
  const spectating = me.status === 'out';
  const playing = room.status === 'playing';

  const { ready: humanReady, status } = useHumanStatus();
  const { videoRef, ready: camReady, error: camError } = useCamera('environment', !spectating);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useWakeLock(true);
  const torch = useTorch(videoRef);

  const [debug, setDebug] = useState(false);
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const [rangeMode, setRangeMode] = useState(false);
  const rangeModeRef = useRef(rangeMode);
  rangeModeRef.current = rangeMode;
  const [rangeDist, setRangeDist] = useState(4);
  const rangeDistRef = useRef(rangeDist);
  rangeDistRef.current = rangeDist;
  const [rangeTick, setRangeTick] = useState(0);
  const [banner, setBanner] = useState<{ text: string; kind: Kind } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [lock, setLock] = useState<{ text: string; kind: Kind } | null>(null);
  const [fps, setFps] = useState(0);

  const tracker = useRef(new Tracker());
  const sampler = useRef(new FrameSampler());
  const zoom = useRef(new ZoomPass());
  const frameNo = useRef(0);
  const fpsWindow = useRef<number[]>([]);
  const latest = useRef<Latest | null>(null);
  const coolRef = useRef(0);
  const bannerTimer = useRef<number | undefined>(undefined);
  const lockKey = useRef('');
  const pending = useRef<PendingShot | null>(null);
  const cropCursor = useRef(0);

  // Everyone enrolled with a compatible profile, including eliminated players and the shooter themself.
  // The shooter's own profile is a decoy: a mirror or a look-alike resolves to "me" and never counts.
  const candidates: Candidate[] = useMemo(
    () =>
      Object.values(room.players)
        .filter((p) => p.enrolled && room.profiles[p.id]?.outfit && room.profiles[p.id].faceModel === FACE_MODEL)
        .map((p) => ({ id: p.id, profile: room.profiles[p.id] })),
    [room.players, room.profiles],
  );
  const exclusiveIds = useMemo(() => new Set(candidates.map((c) => c.id)), [candidates]);
  const eligible = useMemo(() => new Set(alivePlayers(room).filter((p) => p.id !== pid).map((p) => p.id)), [room, pid]);
  const labels = useMemo<Record<string, string>>(
    () => ({ ...Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.id === pid ? 'YOU' : p.name])), [UNKNOWN_ID]: 'STRANGER' }),
    [room.players, pid],
  );
  const colors = useMemo(() => Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.color])), [room.players]);

  const show = (text: string, kind: Kind, ms = 1400) => {
    setBanner({ text, kind });
    window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(null), ms);
  };
  const flashScreen = (color: string, ms = 220) => {
    setFlash(color);
    window.setTimeout(() => setFlash(null), ms);
  };

  // Countdown before the round, then flip to playing.
  useEffect(() => {
    if (room.status !== 'countdown') {
      setCountdown(null);
      return;
    }
    const startAt = room.startAt ?? 0;
    let last = -99;
    const iv = window.setInterval(() => {
      const rem = Math.ceil((startAt - backend.now()) / 1000);
      if (rem !== last) {
        last = rem;
        setCountdown(rem);
        if (rem > 0 && rem <= 5) sfx.countdown();
      }
      if (rem <= 0 && (isHost || backend.now() - startAt > 1500)) void backend.updateMeta(room.code, { status: 'playing' });
    }, 150);
    return () => window.clearInterval(iv);
  }, [room.status, room.startAt, room.code, isHost]);

  const prevRoomStatus = useRef(room.status);
  useEffect(() => {
    if (room.status !== prevRoomStatus.current) {
      prevRoomStatus.current = room.status;
      if (room.status === 'playing') {
        shotLog.clear();
        sfx.go();
        show('GO!', 'good', 1000);
        tracker.current.reset();
        pending.current = null;
      }
    }
  }, [room.status]);

  // Being hit, being eliminated.
  const prevHit = useRef(me.lastHitAt);
  const prevStatus = useRef(me.status);
  useEffect(() => {
    if (me.lastHitAt !== prevHit.current) {
      prevHit.current = me.lastHitAt;
      if (me.lastHitAt > 0) {
        sfx.gotHit();
        vibrate([200, 100, 200]);
        flashScreen('rgba(255,59,92,0.9)', 650);
        show(me.status === 'out' ? 'YOU ARE OUT' : `HIT! ${me.lives} ${me.lives === 1 ? 'life' : 'lives'} left`, 'bad', 2000);
      }
    }
    if (me.status !== prevStatus.current) {
      prevStatus.current = me.status;
      if (me.status === 'out') window.setTimeout(() => sfx.eliminated(), 500);
    }
  }, [me.lastHitAt, me.status, me.lives]);

  // Round end. Decided outright when at most one player is alive. A survivor whose phone has dropped
  // off forfeits after a grace period, so a dead phone cannot hold the round open forever; presence
  // coming back cancels the timer because the effect re-runs on every room change.
  useEffect(() => {
    if (room.status !== 'playing') return;
    const contenders = enrolledPlayers(room);
    if (contenders.length < 2) return;
    const alive = contenders.filter((p) => p.status === 'alive');
    const present = alive.filter((p) => p.connected);
    const decided = alive.length <= 1 || present.length <= 1;
    if (!decided) return;
    const winnerId = (present[0] ?? alive[0])?.id ?? null;
    const grace = alive.length <= 1 ? (isHost ? 0 : 4000) : isHost ? 10000 : 14000;
    const tm = window.setTimeout(
      () => void backend.updateMeta(room.code, { status: 'ended', endedAt: backend.now(), winnerId }).catch(() => undefined),
      grace,
    );
    return () => window.clearTimeout(tm);
  }, [room, isHost]);

  const endRound = () => {
    const alive = alivePlayers(room);
    void backend.updateMeta(room.code, { status: 'ended', endedAt: backend.now(), winnerId: alive.length === 1 ? alive[0].id : null });
  };

  const logShot = (outcome: string, track: Track | null, extra: Partial<Parameters<typeof shotLog.add>[0]> = {}) =>
    shotLog.add({
      t: Date.now(),
      outcome,
      beliefs: track
        ? Object.entries(track.claimed ?? track.belief)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([id, score]) => ({ id, name: labels[id] ?? id, score: roundTo(score, 2) }))
        : [],
      ...extra,
    });

  /** Fold a face seen on a track into its running mean and belief. */
  const applyFace = (t: Track, emb: number[], now: number) => {
    const mean = updateFaceMean(t, emb);
    const fe = faceEvidence(mean, candidates, unitSimilarity, FACE_CALIB);
    const ev = combineEvidence({ face: fe, cloth: null, body: null });
    if (ev) updateBelief(t, ev);
    t.via = 'face';
    t.lastFaceAt = now;
  };

  /** A shot has a verdict: either register it, or in range-test mode just record how the lock behaved. */
  const settleShot = (track: Track, r: Resolution | null, resolveMs: number, zoomed: boolean) => {
    if (rangeModeRef.current) {
      rangeTest.add({
        t: Date.now(),
        distance: rangeDistRef.current,
        locked: Boolean(r),
        targetName: r ? labels[r.id] : undefined,
        score: r ? roundTo(r.score, 2) : undefined,
        resolveMs,
        via: r?.via,
        zoom: zoomed,
      });
      setRangeTick((n) => n + 1);
      if (r) {
        sfx.hit();
        show(`LOCK ${labels[r.id]} ${Math.round(r.score * 100)}% in ${resolveMs}ms`, 'good', 1800);
      } else {
        sfx.unclear();
        show(`NO LOCK in ${resolveMs}ms`, 'warn', 1800);
      }
      return;
    }
    if (!r) {
      const top = topBelief(track);
      sfx.unclear();
      logShot('unclear', track, { resolveMs, zoom: zoomed });
      if (top?.id === pid && top.score > 0.3) return show('THAT IS YOU', 'warn');
      if (top?.id === UNKNOWN_ID && top.score > 0.3) return show('NOT A PLAYER', 'warn');
      return show('UNCLEAR TARGET', 'warn');
    }
    const name = room.players[r.id]?.name ?? '?';
    backend
      .registerHit(room.code, pid, r.id, r.score, r.via)
      .then((out) => {
        logShot(out, track, { targetName: name, via: r.via, resolveMs, zoom: zoomed });
        if (out === 'hit' || out === 'eliminated') {
          sfx.hit();
          flashScreen('rgba(124,255,59,0.35)');
          show(out === 'eliminated' ? `${name} ELIMINATED` : `HIT ${name}`, 'good');
        } else if (out === 'invulnerable') show(`${name} is shielded`, 'info');
        else show('MISS', 'info');
      })
      .catch((e: unknown) => {
        console.warn('hit not registered', e);
        logShot('network error', track, { targetName: name, via: r.via, resolveMs, zoom: zoomed });
        show('NO CONNECTION, SHOT LOST', 'warn', 2000);
      });
  };

  const onFrame = async (res: Result, human: Human) => {
    const v = videoRef.current;
    const wrap = wrapRef.current;
    if (!v || !wrap) return;
    const now = performance.now();
    frameNo.current++;
    fpsWindow.current.push(now);
    while (fpsWindow.current.length && now - fpsWindow.current[0] > 1000) fpsWindow.current.shift();
    if (debugRef.current && frameNo.current % 10 === 0) setFps(fpsWindow.current.length);

    // Bodies first, each claiming the face inside its upper half. Faces with no body become their own detection.
    const dets: Detection[] = [];
    const usedFaces = new Set<number>();
    for (const b of res.body) {
      const box = toNBox(b.boxRaw);
      let faceIdx = -1;
      res.face.forEach((f, i) => {
        if (usedFaces.has(i) || faceIdx >= 0) return;
        const cx = f.boxRaw[0] + f.boxRaw[2] / 2;
        const cy = f.boxRaw[1] + f.boxRaw[3] / 2;
        if (cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3] * 0.55) faceIdx = i;
      });
      if (faceIdx >= 0) usedFaces.add(faceIdx);
      dets.push({ box, body: b, face: faceIdx >= 0 ? res.face[faceIdx] : undefined });
    }
    res.face.forEach((f, i) => {
      if (usedFaces.has(i)) return;
      const [x, y, w, h] = toNBox(f.boxRaw);
      dets.push({ box: clampBox([x - w * 0.5, y - h * 0.3, w * 2, h * 3.5]), face: f });
    });

    const tracks = tracker.current.update(dets, now);
    const img = frameNo.current % CLOTHING_EVERY === 0 ? sampler.current.grab(v) : null;
    dets.forEach((d, i) => {
      const t = tracks[i];
      // Clothing and body ratios only matter while the face is not carrying the identity.
      const faceFresh = now - t.lastFaceAt < FACE_FRESH_MS && (topBelief(t)?.margin ?? 0) >= 0.3;
      if (img && d.body && !faceFresh) {
        let ce: Record<string, number> | null = null;
        let be: Record<string, number> | null = null;
        const sig = outfitSignature(img, d.body);
        if (sig) ce = clothingEvidence(sig, candidates);
        const bp = bodyProportions(d.body);
        if (bp) be = bodyEvidence(bp, candidates);
        const ev = combineEvidence({ face: null, cloth: ce, body: be });
        if (ev) {
          updateBelief(t, ev);
          if (t.via !== 'face' || now - t.lastFaceAt > 3000) t.via = 'clothing';
        }
      }
    });

    // Face embeddings come only from square crops (see ZoomPass). The crosshair target gets one every
    // frame; the other bodies take turns so the frame rate stays predictable.
    const ch = crosshairRect(res.width, res.height, wrap.clientWidth, wrap.clientHeight);
    const idx = indexInSight(
      dets.map((d) => d.box),
      ch,
    );
    const inSight: Track | null = idx >= 0 ? tracks[idx] : null;
    let zoomed = false;
    const order: number[] = [];
    if (idx >= 0) order.push(idx);
    if (dets.length > 1) {
      for (let k = 0; k < dets.length && order.length < 1 + EXTRA_CROPS; k++) {
        const j = (cropCursor.current + k) % dets.length;
        if (j !== idx && dets[j].face) order.push(j);
      }
      cropCursor.current = (cropCursor.current + 1) % dets.length;
    }
    const aspect = res.width / res.height;
    for (const j of order) {
      const d = dets[j];
      const region: NBox = d.face ? faceRegion(toNBox(d.face.boxRaw), aspect) : d.box;
      const faces = await zoom.current.run(human, v, region);
      if (j === idx) zoomed = true;
      const stamp = performance.now();
      for (const zf of faces) {
        if (!zf.face.embedding?.length || faceYawDeg(zf.face) > MAX_YAW_DEG) continue;
        const cx = zf.box[0] + zf.box[2] / 2;
        const cy = zf.box[1] + zf.box[3] / 2;
        const inside = (t: Track) => cx >= t.box[0] && cx <= t.box[0] + t.box[2] && cy >= t.box[1] && cy <= t.box[1] + t.box[3];
        // Attach to the body the crop was taken for when the face lands inside it, else whichever body contains it.
        const owner = (inside(tracks[j]) ? tracks[j] : undefined) ?? tracks.find(inside);
        if (owner) applyFace(owner, unitEmbedding(zf.face.embedding), stamp);
      }
    }

    // One body per player, decided across every live track.
    assignIdentities(tracker.current.live(), exclusiveIds);
    latest.current = { dets, tracks, vidW: res.width, vidH: res.height, t: performance.now() };

    // A borderline shot waits here for the next few frames of evidence.
    const p = pending.current;
    if (p) {
      const t = tracker.current.get(p.trackId);
      const elapsed = Math.round(performance.now() - p.startedAt);
      const r = t ? resolveHit(t, eligible, settings.hitThreshold, settings.hitMargin) : null;
      p.framesLeft--;
      p.zoom ||= zoomed;
      if (!t) {
        pending.current = null;
        logShot('miss', null, { resolveMs: elapsed, zoom: p.zoom });
        show('MISS', 'info');
      } else if (r || performance.now() >= p.deadline || p.framesLeft <= 0) {
        pending.current = null;
        settleShot(t, r, elapsed, p.zoom);
      }
    }

    // Live lock indicator so the shooter knows what a shot would do. Scores are shown in 10% steps
    // so the label (and the re-render it costs) only changes when something meaningful moved.
    let next: { text: string; kind: Kind } | null = null;
    if (inSight) {
      const hit = resolveHit(inSight, eligible, settings.hitThreshold, settings.hitMargin);
      if (hit) next = { text: `LOCK ${labels[hit.id] ?? ''}`, kind: 'good' };
      else {
        const b = bestBelief(inSight, eligible);
        const top = topBelief(inSight);
        if (b && b.score > 0.2) next = { text: `${labels[b.id] ?? ''}? ${Math.round(b.score * 10) * 10}%`, kind: 'warn' };
        else if (top && top.score > 0.3) next = { text: labels[top.id] ?? 'UNKNOWN', kind: 'info' };
        else next = { text: 'UNKNOWN', kind: 'info' };
      }
    }
    const key = next ? next.text + next.kind : '';
    if (key !== lockKey.current) {
      lockKey.current = key;
      setLock(next);
    }

    if (debugRef.current && canvasRef.current) drawOverlay(canvasRef.current, { dets, tracks, vidW: res.width, vidH: res.height, labels, colors }, false);
  };

  useVisionLoop(videoRef, camReady && humanReady && !spectating, onFrame);

  const canFire = (playing || rangeMode) && !spectating && camReady && humanReady;

  const fire = () => {
    unlockAudio();
    const now = Date.now();
    if (now < coolRef.current || !canFire || pending.current) return;
    coolRef.current = now + settings.cooldownMs;
    setCooling(true);
    window.setTimeout(() => setCooling(false), settings.cooldownMs);
    sfx.fire();
    haptic();
    torch(120);
    flashScreen('rgba(255,255,255,0.9)', 90);

    const L = latest.current;
    const wrap = wrapRef.current;
    if (!L || !wrap || performance.now() - L.t > STALE_FRAME_MS) {
      logShot('no camera', null);
      return show('NO CAMERA LOCK', 'warn');
    }
    const ch = crosshairRect(L.vidW, L.vidH, wrap.clientWidth, wrap.clientHeight);
    const idx = indexInSight(
      L.dets.map((d) => d.box),
      ch,
    );
    const best = idx >= 0 ? L.tracks[idx] : null;
    if (!best) {
      logShot('miss', null, { resolveMs: 0 });
      return show('MISS', 'info');
    }
    // Instant when the evidence gathered before the tap already decides it; otherwise wait a few frames.
    const r = resolveHit(best, eligible, settings.hitThreshold, settings.hitMargin);
    if (r) return settleShot(best, r, 0, false);
    pending.current = { trackId: best.id, startedAt: performance.now(), deadline: performance.now() + BURST_MS, framesLeft: BURST_FRAMES, zoom: false };
    show('LOCKING', 'info', BURST_MS + 100);
  };

  const alive = alivePlayers(room);
  const hearts = Array.from({ length: settings.lives }, (_, i) => i < me.lives);
  const rangeSummary = useMemo(() => rangeTest.summary(), [rangeTick]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="game" ref={wrapRef}>
      {!spectating && <video ref={videoRef} className="cam" autoPlay playsInline muted />}
      {!spectating && <canvas ref={canvasRef} className="overlay" style={{ opacity: debug ? 1 : 0 }} />}
      {!spectating && (
        <div className={`crosshair ${lock?.kind ?? ''}`}>{lock && <span className="lock-label">{lock.text}</span>}</div>
      )}
      {flash && <div className="flash" style={{ background: flash }} />}

      <div className="hud-top">
        <div className="hearts">
          {hearts.map((on, i) => (
            <span key={i} className={on ? 'on' : 'off'}>
              ♥
            </span>
          ))}
        </div>
        <div className="hud-mid">{rangeMode ? 'RANGE TEST' : `${alive.length} alive`}</div>
        <div className="row">
          {isHost && playing && (
            <button className="hud-btn" onClick={endRound}>
              end round
            </button>
          )}
          {debug && (
            <button className={`hud-btn ${rangeMode ? 'on' : ''}`} onClick={() => setRangeMode((m) => !m)}>
              {rangeMode ? 'range on' : 'range'}
            </button>
          )}
          <button className="hud-btn" onClick={() => setDebug((d) => !d)}>
            {debug ? `${fps} fps` : 'debug'}
          </button>
        </div>
      </div>

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      {countdown !== null && <div className="countdown">{countdown > 0 ? countdown : 'GO'}</div>}
      {!spectating && (!camReady || !humanReady) && <div className="status-pill">{camError ?? (camReady ? status : 'Starting camera')}</div>}

      {rangeMode && !spectating && (
        <div className="range-panel">
          <div className="row">
            <span>Target at</span>
            {RANGE_DISTANCES.map((d) => (
              <button key={d} className={`chip-btn ${rangeDist === d ? 'on' : ''}`} onClick={() => setRangeDist(d)}>
                {d} m
              </button>
            ))}
            <button
              className="chip-btn"
              onClick={() => {
                rangeTest.clear();
                setRangeTick((n) => n + 1);
              }}
            >
              clear
            </button>
          </div>
          {rangeSummary.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>dist</th>
                  <th>shots</th>
                  <th>lock</th>
                  <th>ms</th>
                  <th>zoom</th>
                </tr>
              </thead>
              <tbody>
                {rangeSummary.map((s) => (
                  <tr key={s.distance}>
                    <td>{s.distance} m</td>
                    <td>{s.shots}</td>
                    <td>{Math.round(s.lockRate * 100)}%</td>
                    <td>{Math.round(s.meanResolveMs)}</td>
                    <td>{Math.round(s.zoomRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <span className="tag">Shots here deal no damage.</span>
        </div>
      )}

      {spectating ? (
        <div className="spectator">
          <h2>You are out</h2>
          <p className="sub">Watch the rest of the round.</p>
          <ul className="players">
            {enrolledPlayers(room)
              .sort((a, b) => b.lives - a.lives)
              .map((p) => (
                <li key={p.id}>
                  <span className="dot" style={{ background: p.color }} />
                  <span className="name">{p.name}</span>
                  <span className="tag">{livesLabel(p)}</span>
                </li>
              ))}
          </ul>
          <button className="link" onClick={onLeave}>
            Leave
          </button>
        </div>
      ) : (
        <button className={`fire ${cooling ? 'cooling' : ''}`} disabled={!canFire} onPointerDown={fire} onClick={unlockAudio}>
          FIRE
        </button>
      )}
      {MIN_PLAYERS === 1 && isHost && enrolledPlayers(room).length < 2 && playing && !rangeMode && (
        <div className="status-pill solo-note">Solo test: tap "end round" when you are done.</div>
      )}
    </div>
  );
}
