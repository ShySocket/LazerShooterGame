import { useEffect, useMemo, useRef, useState } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { backend, MIN_PLAYERS } from '../net';
import { decideRoundEnd } from '../net/backend';
import { alivePlayers, enrolledPlayers, livesLabel, UNKNOWN_ID, type Player, type Room } from '../types';
import { useCamera } from '../hooks/useCamera';
import { useVisionLoop, type VisionFrame } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { useWakeLock } from '../hooks/useWakeLock';
import { useTorch } from '../hooks/useTorch';
import { buildDetections, type Track } from '../vision/tracker';
import { crosshairRect, indexInSight, type NBox } from '../vision/geometry';
import { FrameSampler } from '../vision/clothing';
import { topBelief, type Candidate } from '../vision/scoring';
import { compactEmbedding, isCurrentFaceScan } from '../vision/human';
import { ZoomPass } from '../vision/zoom';
import { VisionPipeline, type LockState, type ShotSettlement } from '../vision/pipeline';
import { makeFrameOps } from '../vision/frameOps';
import { visionProfile } from '../vision/frameClock';
import { shotLog } from '../debug/shotLog';
import { Recorder } from '../debug/recorder';
import { rangeTest } from '../debug/rangeTest';
import { drawOverlay } from '../vision/overlay';
import { haptic, sfx, unlockAudio, vibrate } from '../audio/sfx';
import { roundTo } from '../util/num';
import { ShotRecorder } from '../feedback/recorder';
import { FrameKeeper, renderShotPhoto } from '../feedback/photo';
import { feedbackStore } from '../feedback/store';
import { IdMap, REVIEWABLE_OUTCOMES } from '../feedback/sample';

interface Props {
  room: Room;
  me: Player;
  pid: string;
  onLeave: () => void;
}

interface ShotContext {
  practice: boolean;
  distance: number;
  expectedId: string;
  /** Ties the verdict back to the feedback recorder's record of the tap. */
  shotId: string;
}

type Kind = 'info' | 'good' | 'warn' | 'bad';

const RANGE_DISTANCES = [2, 4, 6, 8];

export function Game({ room, me, pid, onLeave }: Props) {
  const isHost = room.hostId === pid;
  const settings = room.settings;
  const spectating = me.status === 'out';
  const playing = room.status === 'playing';

  const { ready: humanReady, status, failed: humanFailed, retry: retryModels } = useHumanStatus();
  const { videoRef, ready: camReady, error: camError, retry: retryCamera } = useCamera('environment', !spectating);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useWakeLock(true);
  const torch = useTorch(videoRef);

  const [debug, setDebug] = useState(false);
  // ?record captures every frame's detections, crops and outfits plus every tap as numbers (never
  // pixels) for offline replay through the same pipeline: npm run replay <folder>.
  const replayRecorder = useRef<Recorder | null>(null);
  const [recordedFrames, setRecordedFrames] = useState(0);
  const recording = useMemo(() => new URL(location.href).searchParams.has('record'), []);
  const debugRef = useRef(debug);
  debugRef.current = debug;
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeDist, setRangeDist] = useState(4);
  const [rangeTargetId, setRangeTargetId] = useState('');
  const [rangeTick, setRangeTick] = useState(0);
  const [banner, setBanner] = useState<{ text: string; kind: Kind } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [lock, setLock] = useState<{ text: string; kind: Kind } | null>(null);
  const [fps, setFps] = useState(0);

  const pipeline = useRef(new VisionPipeline<ShotContext>({ candidates: [], exclusiveIds: new Set(), eligible: new Set(), hitThreshold: 1, hitMargin: 1 }));
  const sampler = useRef(new FrameSampler());
  const zoom = useRef(new ZoomPass());
  const frameNo = useRef(0);
  const fpsWindow = useRef<number[]>([]);
  const coolRef = useRef(0);
  const bannerTimer = useRef<number | undefined>(undefined);
  const lockKey = useRef('');
  const pendingTimer = useRef<number | undefined>(undefined);
  const settleRef = useRef<(s: ShotSettlement<ShotContext>) => void>(() => undefined);
  // Shot feedback: what the pipeline saw around every FIRE press, and a small copy of the frame it
  // was decided on, so a failed shot can be shown back to the shooter on the results screen.
  const recorder = useRef(new ShotRecorder());
  const keeper = useRef(new FrameKeeper());
  const photos = useRef(new Map<string, Promise<Blob | null>>());
  const settledBy = useRef<'tap' | 'frame' | 'timer'>('tap');

  useEffect(() => {
    const invalidate = () => {
      const dropped = pipeline.current.invalidate();
      window.clearTimeout(pendingTimer.current);
      lockKey.current = '';
      setLock(null);
      // A burst in flight will never settle now; its record and photo go with it. The tap still gets
      // its verdict: the player sees SHOT LOST instead of a silent nothing.
      recorder.current.abandonOpenShots();
      photos.current.clear();
      if (dropped && !dropped.practice) {
        logShot('shot lost', null, { resolveMs: 0 }, dropped.shotId);
        show('SHOT LOST', 'warn');
      }
    };
    invalidate();
    // The crosshair rectangle depends on the viewport, so a real size change (rotation, split view)
    // discards frames measured against the old one. Mobile browsers also fire resize when the address
    // bar slides, which leaves the game area untouched and must not reset tracking mid-shot.
    let lastSize = `${wrapRef.current?.clientWidth}x${wrapRef.current?.clientHeight}`;
    const onResize = () => {
      const size = `${wrapRef.current?.clientWidth}x${wrapRef.current?.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      invalidate();
    };
    document.addEventListener('visibilitychange', invalidate);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('visibilitychange', invalidate);
      window.removeEventListener('resize', onResize);
      pipeline.current.invalidate();
      window.clearTimeout(pendingTimer.current);
    };
  }, [room.status, spectating, camReady]);

  // Watchdog independent of the vision loop: if frames stop completing (a frozen camera, repeated
  // inference errors, a paused tab), the green LOCK must not stay on screen from the last good frame.
  useEffect(() => {
    const iv = window.setInterval(() => {
      const L = pipeline.current.getLatest();
      const limit = Math.max(1000, pipeline.current.staleMs() * 2);
      if (L && performance.now() - L.t > limit && lockKey.current) {
        lockKey.current = '';
        setLock({ text: 'NO FRESH FRAMES', kind: 'warn' });
      }
    }, 300);
    return () => window.clearInterval(iv);
  }, []);

  // Everyone enrolled with a compatible profile, including eliminated players and the shooter themself.
  // The shooter's own profile is a decoy: a mirror or a look-alike resolves to "me" and never counts.
  const candidates: Candidate[] = useMemo(
    () =>
      Object.values(room.players)
        .filter((p) => p.enrolled && room.profiles[p.id]?.outfit && isCurrentFaceScan(room.profiles[p.id]))
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
  pipeline.current.configure({ candidates, exclusiveIds, eligible, hitThreshold: settings.hitThreshold, hitMargin: settings.hitMargin });

  // A range-test target who was eliminated or left would otherwise keep being "expected" silently.
  useEffect(() => {
    if (rangeTargetId && rangeTargetId !== UNKNOWN_ID && !eligible.has(rangeTargetId)) setRangeTargetId('');
  }, [rangeTargetId, eligible]);

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

  // Each round's profile stands on its own; the bench resets its own at start.
  useEffect(() => {
    if (room.status === 'playing') visionProfile.reset();
  }, [room.status]);

  const prevRoomStatus = useRef(room.status);
  useEffect(() => {
    if (room.status !== prevRoomStatus.current) {
      prevRoomStatus.current = room.status;
      if (room.status === 'playing') {
        shotLog.clear();
        sfx.go();
        show('GO!', 'good', 1000);
        pipeline.current.invalidate();
        window.clearTimeout(pendingTimer.current);
        // The recorder needs the round's players as they are now; the store keeps their profiles
        // (numeric signatures only) so a labelled shot can be re-scored offline.
        const ids = candidates.map((c) => c.id);
        const startAt = room.startAt ?? backend.now();
        const key = recorder.current.startRound({ code: room.code, startAt, settings, playerIds: ids, shooter: pid });
        const idMap = new IdMap(ids);
        const profiles = Object.fromEntries(candidates.map((c) => [idMap.pid(c.id), { ...c.profile, face: (c.profile.face ?? []).map(compactEmbedding) }]));
        void feedbackStore.beginRound({ key, code: room.code, startAt, ids: idMap.all(), profiles });
        keeper.current.clear();
        photos.current.clear();
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
  // coming back cancels the timer because the effect re-runs on every room change. The write itself
  // is backend.endRound: one transaction that re-checks the players map, so however many phones
  // reach this point they end the round once, with one winner.
  useEffect(() => {
    if (room.status !== 'playing') return;
    const end = decideRoundEnd(room.players);
    if (!end.decided) return;
    const grace = !end.forfeit ? (isHost ? 0 : 4000) : isHost ? 10000 : 14000;
    const tm = window.setTimeout(() => void backend.endRound(room.code).catch((e: unknown) => console.warn('endRound failed', e)), grace);
    return () => window.clearTimeout(tm);
  }, [room, isHost]);

  const endRound = () => {
    void backend.endRound(room.code, true).catch(() => undefined);
  };

  /** The verdict reaches the feedback recorder; a failed shot keeps its photo for the review card. */
  const recordVerdict = (shotId: string, outcome: string, track: Track | null, extra: { targetId?: string; via?: string; resolveMs?: number; zoom?: boolean }) => {
    const photo = photos.current.get(shotId) ?? Promise.resolve(null);
    photos.current.delete(shotId);
    const sample = recorder.current.endShot(shotId, {
      outcome,
      resolvedTo: extra.targetId ?? null,
      via: extra.via ?? null,
      resolveMs: extra.resolveMs ?? null,
      zoom: Boolean(extra.zoom),
      track,
      settledBy: settledBy.current,
    });
    if (!sample || !REVIEWABLE_OUTCOMES.has(outcome)) return;
    void photo.then((blob) => feedbackStore.saveShot({ id: shotId, round: sample.round.key, outcome, hadTrack: sample.shot.trackId !== null, roundMs: sample.shot.roundMs, sample, photo: blob }));
  };

  const logShot = (outcome: string, track: Track | null, extra: Partial<Parameters<typeof shotLog.add>[0]> = {}, shotId?: string) => {
    shotLog.add({
      t: Date.now(),
      outcome,
      liveFaces: pipeline.current.liveFaceCounts(),
      beliefs: track
        ? Object.entries(track.claimed ?? track.belief)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([id, score]) => ({ id, name: labels[id] ?? id, score: roundTo(score, 2) }))
        : [],
      ...extra,
    });
    if (shotId) recordVerdict(shotId, outcome, track, extra);
  };

  /** A shot has a verdict: either register it, or in range-test mode just record how the lock behaved. */
  const settleShot = ({ track, resolution: r, elapsedMs: resolveMs, zoomed, context }: ShotSettlement<ShotContext>) => {
    if (context.practice) {
      rangeTest.add({
        t: Date.now(),
        distance: context.distance,
        expectedId: context.expectedId,
        targetId: r?.id,
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
    if (!r && !track) {
      // The target left the crosshair, or was replaced by somebody else, before the burst could confirm it.
      sfx.unclear();
      logShot('miss', null, { resolveMs, zoom: zoomed }, context.shotId);
      return show('MISS', 'info');
    }
    if (!r) {
      const top = topBelief(track!);
      sfx.unclear();
      logShot('unclear', track, { resolveMs, zoom: zoomed }, context.shotId);
      if (top?.id === pid && top.score > 0.3) return show('THAT IS YOU', 'warn');
      if (top?.id === UNKNOWN_ID && top.score > 0.3) return show('NOT A PLAYER', 'warn');
      return show('UNCLEAR TARGET', 'warn');
    }
    const name = room.players[r.id]?.name ?? '?';
    backend
      .registerHit(room.code, pid, r.id, r.score, r.via)
      .then((out) => {
        logShot(out, track, { targetName: name, targetId: r.id, via: r.via, resolveMs, zoom: zoomed }, context.shotId);
        if (out === 'hit' || out === 'eliminated') {
          sfx.hit();
          flashScreen('rgba(124,255,59,0.35)');
          show(out === 'eliminated' ? `${name} ELIMINATED` : `HIT ${name}`, 'good');
        } else if (out === 'invulnerable') show(`${name} is shielded`, 'info');
        else show('MISS', 'info');
      })
      .catch((e: unknown) => {
        console.warn('hit not registered', e);
        logShot('network error', track, { targetName: name, targetId: r.id, via: r.via, resolveMs, zoom: zoomed }, context.shotId);
        show('NO CONNECTION, SHOT LOST', 'warn', 2000);
      });
  };
  settleRef.current = settleShot;

  const lockLabel = (lock: LockState | null): { text: string; kind: Kind } | null => {
    if (!lock) return null;
    // Scores are shown in 10% steps so the label (and the re-render it costs) only changes when something moved.
    switch (lock.kind) {
      case 'lock':
        return { text: `LOCK ${labels[lock.id] ?? ''}`, kind: 'good' };
      case 'maybe':
        return { text: `${labels[lock.id] ?? ''}? ${Math.round(lock.score * 10) * 10}%`, kind: 'warn' };
      case 'top':
        return { text: labels[lock.id] ?? 'UNKNOWN', kind: 'info' };
      default:
        return { text: 'UNKNOWN', kind: 'info' };
    }
  };

  const onFrame = async (res: Result, human: Human, frame: VisionFrame) => {
    const v = videoRef.current;
    const wrap = wrapRef.current;
    if (!v || !wrap || !frame.isCurrent()) return;
    const now = frame.capturedAt;
    frameNo.current++;
    fpsWindow.current.push(now);
    while (fpsWindow.current.length && now - fpsWindow.current[0] > 1000) fpsWindow.current.shift();
    if (debugRef.current && frameNo.current % 10 === 0) setFps(fpsWindow.current.length);

    const dets = buildDetections(res.body, res.face);
    const ch = crosshairRect(res.width, res.height, wrap.clientWidth, wrap.clientHeight);
    const { ops: baseOps, done } = makeFrameOps({ frame: frame.frame, width: res.width, height: res.height, human, zoom: zoom.current, sampler: sampler.current, isCurrent: frame.isCurrent });
    if (playing && !rangeMode) keeper.current.keep(frame.frame, now);
    // The shot-feedback recorder sees every observation; the optional ?record recorder wraps it in turn.
    const ops = recorder.current.wrapOps(baseOps, dets);
    if (recording && !replayRecorder.current) {
      replayRecorder.current = new Recorder({ width: res.width, height: res.height, candidates, selfId: pid, hitThreshold: settings.hitThreshold, hitMargin: settings.hitMargin, notes: `room ${room.code}, ${navigator.userAgent}` });
      if (import.meta.env.DEV) (window as unknown as { __lzRecorder?: Recorder }).__lzRecorder = replayRecorder.current;
    }
    const outcome = await pipeline.current.processFrame(dets, now, res.width, res.height, ch, replayRecorder.current ? replayRecorder.current.frame(now, ch, dets, ops) : ops);
    // A frame the pipeline abandoned (camera changed, round reset) never happened as far as a replay is concerned.
    if (!outcome) replayRecorder.current?.discardLast();
    if (replayRecorder.current && replayRecorder.current.frameCount % 20 === 0) setRecordedFrames(replayRecorder.current.frameCount);
    done();
    if (!outcome) return;
    recorder.current.frameDone(outcome, dets, now, candidates);
    if (outcome.settled) {
      window.clearTimeout(pendingTimer.current);
      settledBy.current = 'frame';
      settleShot(outcome.settled);
    }

    const next = lockLabel(outcome.lock);
    const key = next ? next.text + next.kind : '';
    if (key !== lockKey.current) {
      lockKey.current = key;
      setLock(next);
    }

    if (debugRef.current && canvasRef.current) drawOverlay(canvasRef.current, { dets, tracks: outcome.tracks, vidW: res.width, vidH: res.height, labels, colors }, false);
  };

  useVisionLoop(videoRef, camReady && humanReady && !spectating, onFrame);

  const canFire = (playing || rangeMode) && !spectating && camReady && humanReady && (!rangeMode || Boolean(rangeTargetId));

  const fire = () => {
    unlockAudio();
    const now = Date.now();
    if (now < coolRef.current || !canFire || pipeline.current.hasPending()) return;
    coolRef.current = now + settings.cooldownMs;
    setCooling(true);
    window.setTimeout(() => setCooling(false), settings.cooldownMs);
    sfx.fire();
    haptic();
    torch(120);
    flashScreen('rgba(255,255,255,0.9)', 90);
    const shotId = `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const context: ShotContext = { practice: rangeMode, distance: rangeDist, expectedId: rangeTargetId, shotId };

    const L = pipeline.current.getLatest();
    const wrap = wrapRef.current;
    const usable = Boolean(L && wrap && !document.hidden && L.width === videoRef.current?.videoWidth && L.height === videoRef.current?.videoHeight);
    const ch = L && wrap ? crosshairRect(L.width, L.height, wrap.clientWidth, wrap.clientHeight) : ([0, 0, 0, 0] as NBox);
    // In range mode the shooter has named their target, so the tap is labelled for the validation set.
    replayRecorder.current?.fire(performance.now(), ch, context.practice ? context.expectedId : undefined, eligible);
    const result = pipeline.current.fire(context, ch, usable);
    settledBy.current = 'tap';
    if (result.kind !== 'busy' && !context.practice && L && recorder.current.active()) {
      const tapAt = performance.now();
      const idx = indexInSight(L.dets.map((d) => d.box), ch);
      const track = result.kind === 'instant' ? result.settlement.track : idx >= 0 ? L.tracks[idx] : null;
      recorder.current.beginShot({
        id: shotId,
        tapAt,
        roundNow: backend.now(),
        kind: result.kind,
        crosshair: ch,
        frameT: L.t,
        frameAgeMs: Math.round(tapAt - L.t),
        allowanceMs: pipeline.current.staleMs(),
        trackId: track?.id ?? null,
        track,
        width: L.width,
        height: L.height,
        periodMs: pipeline.current.periodMs(),
        staleMs: pipeline.current.staleMs(),
        burstMs: pipeline.current.burstMs(),
        liveFaces: {},
        eligible,
      });
      const kept = keeper.current.take(L.t);
      photos.current.set(shotId, kept ? renderShotPhoto(kept, ch) : Promise.resolve(null));
    }
    switch (result.kind) {
      case 'busy':
        return;
      case 'no-camera':
      case 'stale': {
        if (context.practice) return settleShot({ track: null, resolution: null, elapsedMs: 0, zoomed: false, context });
        // The shot log records the frame age next to the allowance, which is the number to compare with staleMs().
        if (result.kind === 'stale') logShot('stale frame', null, { resolveMs: result.frameAgeMs, allowanceMs: result.allowanceMs }, shotId);
        else logShot('no camera', null, { resolveMs: 0 }, shotId);
        // Nothing was fired at anybody: the cooldown is not spent on a refused tap.
        coolRef.current = now;
        setCooling(false);
        return show(result.kind === 'stale' ? 'CAMERA TOO SLOW' : 'NO CAMERA LOCK', 'warn');
      }
      case 'miss':
        if (context.practice) return settleShot({ track: null, resolution: null, elapsedMs: 0, zoomed: false, context });
        logShot('miss', null, { resolveMs: 0 }, shotId);
        return show('MISS', 'info');
      case 'instant':
        return settleShot(result.settlement);
      case 'pending': {
        const { token, burstMs } = result;
        pendingTimer.current = window.setTimeout(() => {
          const settlement = pipeline.current.expirePending(token);
          settledBy.current = 'timer';
          if (settlement) settleRef.current(settlement);
        }, burstMs);
        show('LOCKING', 'info', burstMs + 100);
      }
    }
  };

  /** Hands the recording to the browser as a JSON download; the player attaches it to a bug report or a replay folder. */
  const saveRecording = () => {
    const rec = replayRecorder.current?.recording();
    if (!rec) return;
    const blob = new Blob([JSON.stringify(rec)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lazer-recording-${room.code}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    // Attached to the document for the click: some mobile browsers ignore a detached anchor's download.
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 10000);
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
          {recording && (
            <button className="hud-btn" onClick={saveRecording}>
              save rec {recordedFrames}{replayRecorder.current?.full ? ' (full)' : ''}
            </button>
          )}
        </div>
      </div>

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      {countdown !== null && <div className="countdown">{countdown > 0 ? countdown : 'GO'}</div>}
      {!spectating && (!camReady || !humanReady) && (
        <div className="status-pill">
          {camError ?? (camReady ? status : 'Starting camera')}
          {(camError || humanFailed) && (
            <button className="hud-btn" style={{ marginLeft: 8 }} onClick={camError ? retryCamera : retryModels}>
              retry
            </button>
          )}
        </div>
      )}

      {rangeMode && !spectating && (
        <div className="range-panel">
          <label className="row">
            Aim at
            <select aria-label="Expected range test target" value={rangeTargetId} onChange={(event) => setRangeTargetId(event.target.value)}>
              <option value="">Choose target</option>
              {candidates.filter((c) => eligible.has(c.id)).map((c) => <option key={c.id} value={c.id}>{labels[c.id]}</option>)}
              <option value={UNKNOWN_ID}>Not a player / empty space</option>
            </select>
          </label>
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
                  <th>correct</th>
                  <th>wrong</th>
                  <th>missed</th>
                </tr>
              </thead>
              <tbody>
                {rangeSummary.map((s) => (
                  <tr key={s.distance}>
                    <td>{s.distance} m</td>
                    <td>{s.shots}</td>
                    <td>{s.correct}/{s.evaluated}</td>
                    <td>{s.wrongPlayer + s.falseLocks}</td>
                    <td>{s.missed}</td>
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
