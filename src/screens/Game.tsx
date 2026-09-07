import { useEffect, useMemo, useRef, useState } from 'react';
import type { Human, Result } from '@vladmandic/human';
import { backend } from '../net';
import type { Player, Room } from '../types';
import { useCamera } from '../hooks/useCamera';
import { useVisionLoop } from '../hooks/useVisionLoop';
import { useHumanStatus } from '../hooks/useHumanStatus';
import { useWakeLock } from '../hooks/useWakeLock';
import { useTorch } from '../hooks/useTorch';
import { Tracker, type Detection, type Track } from '../vision/tracker';
import { clampBox, crosshairRect, intersectArea, type NBox } from '../vision/geometry';
import { FrameSampler, torsoQuad, torsoSignature } from '../vision/clothing';
import { bestBelief, clothingEvidence, combineEvidence, faceEvidence, resolveHit, updateBelief, type Candidate } from '../vision/scoring';
import { drawOverlay } from '../vision/overlay';
import { haptic, sfx, unlockAudio, vibrate } from '../audio/sfx';

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

type Kind = 'info' | 'good' | 'warn' | 'bad';

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
  const [banner, setBanner] = useState<{ text: string; kind: Kind } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [lock, setLock] = useState<{ text: string; kind: Kind } | null>(null);
  const [fps, setFps] = useState(0);

  const tracker = useRef(new Tracker());
  const sampler = useRef(new FrameSampler());
  const frameNo = useRef(0);
  const fpsWindow = useRef<number[]>([]);
  const latest = useRef<Latest | null>(null);
  const coolRef = useRef(0);
  const bannerTimer = useRef<number | undefined>(undefined);
  const lockKey = useRef('');

  // Everyone else who is enrolled, including eliminated players, so their bodies do not get mistaken for someone alive.
  const candidates: Candidate[] = useMemo(
    () =>
      Object.values(room.players)
        .filter((p) => p.id !== pid && p.enrolled && room.profiles[p.id])
        .map((p) => ({ id: p.id, profile: room.profiles[p.id] })),
    [room.players, room.profiles, pid],
  );
  const eligible = useMemo(
    () => new Set(Object.values(room.players).filter((p) => p.id !== pid && p.enrolled && p.status === 'alive').map((p) => p.id)),
    [room.players, pid],
  );
  const labels = useMemo(() => Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.name])), [room.players]);
  const colors = useMemo(() => Object.fromEntries(Object.values(room.players).map((p) => [p.id, p.color])), [room.players]);
  const candRef = useRef(candidates);
  candRef.current = candidates;
  const eligRef = useRef(eligible);
  eligRef.current = eligible;

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
        sfx.go();
        show('GO!', 'good', 1000);
        tracker.current.reset();
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

  // Round ends when one (or zero) enrolled players remain alive.
  useEffect(() => {
    if (room.status !== 'playing') return;
    const enrolled = Object.values(room.players).filter((p) => p.enrolled);
    const alive = enrolled.filter((p) => p.status === 'alive');
    if (enrolled.length < 2 || alive.length > 1) return;
    const end = () => backend.updateMeta(room.code, { status: 'ended', endedAt: backend.now(), winnerId: alive[0]?.id ?? null });
    if (isHost) {
      void end();
      return;
    }
    const tm = window.setTimeout(() => void end(), 4000);
    return () => window.clearTimeout(tm);
  }, [room.players, room.status, room.code, isHost]);

  const onFrame = (res: Result, human: Human) => {
    const v = videoRef.current;
    const wrap = wrapRef.current;
    if (!v || !wrap) return;
    const now = performance.now();
    frameNo.current++;
    fpsWindow.current.push(now);
    while (fpsWindow.current.length && now - fpsWindow.current[0] > 1000) fpsWindow.current.shift();
    if (frameNo.current % 10 === 0) setFps(fpsWindow.current.length);

    // Bodies first, each claiming the face inside its upper half. Faces with no body become their own detection.
    const dets: Detection[] = [];
    const usedFaces = new Set<number>();
    for (const b of res.body) {
      const box = b.boxRaw as NBox;
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
      const [x, y, w, h] = f.boxRaw as NBox;
      dets.push({ box: clampBox([x - w * 0.5, y - h * 0.3, w * 2, h * 3.5]), face: f });
    });

    const tracks = tracker.current.update(dets, now);
    const img = frameNo.current % 2 === 0 ? sampler.current.grab(v) : null;
    const cands = candRef.current;
    dets.forEach((d, i) => {
      const t = tracks[i];
      const fe = d.face?.embedding?.length ? faceEvidence(d.face.embedding, cands, human.match.similarity) : null;
      let ce: Record<string, number> | null = null;
      if (img && d.body) {
        const q = torsoQuad(d.body);
        if (q) ce = clothingEvidence(torsoSignature(img, q), cands);
      }
      const ev = combineEvidence(fe, ce);
      if (ev) {
        updateBelief(t, ev);
        if (fe) {
          t.via = 'face';
          t.lastFaceAt = now;
        } else if (t.via !== 'face' || now - t.lastFaceAt > 3000) t.via = 'clothing';
      }
    });

    latest.current = { dets, tracks, vidW: res.width, vidH: res.height, t: now };

    // Live lock indicator so the shooter knows what a shot would do.
    const ch = crosshairRect(res.width, res.height, wrap.clientWidth, wrap.clientHeight);
    let inSight: Track | null = null;
    let bestA = 0;
    for (let i = 0; i < dets.length; i++) {
      const a = intersectArea(dets[i].box, ch);
      if (a > bestA) {
        bestA = a;
        inSight = tracks[i];
      }
    }
    let next: { text: string; kind: Kind } | null = null;
    if (inSight) {
      const hit = resolveHit(inSight, eligRef.current, settings.hitThreshold, settings.hitMargin);
      if (hit) next = { text: `LOCK ${labels[hit.id] ?? ''}`, kind: 'good' };
      else {
        const b = bestBelief(inSight, eligRef.current);
        next = b && b.score > 0.2 ? { text: `${labels[b.id] ?? ''}? ${Math.round(b.score * 100)}%`, kind: 'warn' } : { text: 'UNKNOWN', kind: 'info' };
      }
    }
    const key = next ? next.text + next.kind : '';
    if (key !== lockKey.current) {
      lockKey.current = key;
      setLock(next);
    }

    if (canvasRef.current) drawOverlay(canvasRef.current, { dets, tracks, vidW: res.width, vidH: res.height, labels, colors }, false);
  };

  useVisionLoop(videoRef, camReady && humanReady && !spectating, onFrame);

  const fire = () => {
    unlockAudio();
    const now = Date.now();
    if (now < coolRef.current || !playing || spectating) return;
    coolRef.current = now + settings.cooldownMs;
    setCooling(true);
    window.setTimeout(() => setCooling(false), settings.cooldownMs);
    sfx.fire();
    haptic();
    torch(120);
    flashScreen('rgba(255,255,255,0.9)', 90);

    const L = latest.current;
    const wrap = wrapRef.current;
    if (!L || !wrap || performance.now() - L.t > 800) return show('NO CAMERA LOCK', 'warn');
    const ch = crosshairRect(L.vidW, L.vidH, wrap.clientWidth, wrap.clientHeight);
    let best: Track | null = null;
    let bestA = 0;
    for (let i = 0; i < L.dets.length; i++) {
      const a = intersectArea(L.dets[i].box, ch);
      if (a > bestA) {
        bestA = a;
        best = L.tracks[i];
      }
    }
    if (!best) return show('MISS', 'info');
    const r = resolveHit(best, eligible, settings.hitThreshold, settings.hitMargin);
    if (!r) {
      sfx.unclear();
      return show('UNCLEAR TARGET', 'warn');
    }
    const name = room.players[r.id]?.name ?? '?';
    void backend.registerHit(room.code, pid, r.id, r.score, r.via).then((out) => {
      if (out === 'hit' || out === 'eliminated') {
        sfx.hit();
        flashScreen('rgba(124,255,59,0.35)');
        show(out === 'eliminated' ? `${name} ELIMINATED` : `HIT ${name}`, 'good');
      } else if (out === 'invulnerable') show(`${name} is shielded`, 'info');
      else show('MISS', 'info');
    });
  };

  const alivePlayers = Object.values(room.players).filter((p) => p.enrolled && p.status === 'alive');
  const hearts = Array.from({ length: settings.lives }, (_, i) => i < me.lives);

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
        <div className="hud-mid">{alivePlayers.length} alive</div>
        <button className="hud-btn" onClick={() => setDebug((d) => !d)}>
          {debug ? `${fps} fps` : 'debug'}
        </button>
      </div>

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      {countdown !== null && <div className="countdown">{countdown > 0 ? countdown : 'GO'}</div>}
      {!spectating && (!camReady || !humanReady) && <div className="status-pill">{camError ?? (camReady ? status : 'Starting camera')}</div>}

      {spectating ? (
        <div className="spectator">
          <h2>You are out</h2>
          <p className="sub">Watch the rest of the round.</p>
          <ul className="players">
            {Object.values(room.players)
              .filter((p) => p.enrolled)
              .sort((a, b) => b.lives - a.lives)
              .map((p) => (
                <li key={p.id}>
                  <span className="dot" style={{ background: p.color }} />
                  <span className="name">{p.name}</span>
                  <span className="tag">{p.status === 'alive' ? `${p.lives} ♥` : 'out'}</span>
                </li>
              ))}
          </ul>
          <button className="link" onClick={onLeave}>
            Leave
          </button>
        </div>
      ) : (
        <button className={`fire ${cooling ? 'cooling' : ''}`} disabled={!playing} onPointerDown={fire} onClick={unlockAudio}>
          FIRE
        </button>
      )}
    </div>
  );
}
