import { useEffect, useMemo, useState } from 'react';
import { backend, MIN_PLAYERS } from '../net';
import { CLOTHING_CONFLICT, type Player, type Room, type RoomSettings } from '../types';
import { outfitConflict } from '../vision/clothing';
import { centredSimilarity, FACE_CONFLICT, isCurrentFaceScan } from '../vision/human';
import { haptic, sfx, unlockAudio } from '../audio/sfx';
import { useAudioState } from '../hooks/useAudioState';
import { ShotReview } from '../feedback/ShotReview';

interface Props {
  room: Room;
  me: Player;
  pid: string;
  onLeave: () => void;
}

export function Lobby({ room, me, pid, onLeave }: Props) {
  const isHost = room.hostId === pid;
  const [settings, setSettings] = useState<RoomSettings>(room.settings);
  const [copied, setCopied] = useState(false);
  const audio = useAudioState();
  useEffect(() => setSettings(room.settings), [room.settings]);

  const players = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
  const connected = players.filter((p) => p.connected);
  const enrolled = connected.filter((p) => p.enrolled && room.profiles[p.id]);
  // Profiles made by an older build lack the outfit, use another face model, or carry damaged embeddings
  // that could never match. They must re-enroll rather than play as an unhittable target.
  const stale = enrolled.filter((p) => !room.profiles[p.id].outfit?.front?.top || !isCurrentFaceScan(room.profiles[p.id]));

  const conflicts: { a: Player; b: Player; sim: number }[] = [];
  for (let i = 0; i < enrolled.length; i++) {
    for (let j = i + 1; j < enrolled.length; j++) {
      if (!room.profiles[enrolled[i].id].outfit || !room.profiles[enrolled[j].id].outfit) continue;
      const sim = outfitConflict(room.profiles[enrolled[i].id].outfit, room.profiles[enrolled[j].id].outfit);
      if (sim > CLOTHING_CONFLICT) conflicts.push({ a: enrolled[i], b: enrolled[j], sim });
    }
  }

  // Faces that read alike at this model's resolution: not a blocker (the outfit still separates them),
  // but the players should know that a look-alike hit resolves by clothing alone.
  // Stored samples are already unit embeddings, so centredSimilarity's per-array cache serves repeat
  // renders; the pair loop itself runs only when the profiles or the enrolled set change.
  const enrolledIds = enrolled.map((p) => p.id).join(',');
  const faceAlike = useMemo(() => {
    const out: { a: Player; b: Player; sim: number }[] = [];
    for (let i = 0; i < enrolled.length; i++) {
      for (let j = i + 1; j < enrolled.length; j++) {
        let best = 0;
        for (const fa of room.profiles[enrolled[i].id].face ?? []) for (const fb of room.profiles[enrolled[j].id].face ?? []) best = Math.max(best, centredSimilarity(fa, fb));
        if (best > FACE_CONFLICT) out.push({ a: enrolled[i], b: enrolled[j], sim: best });
      }
    }
    return out;
  }, [room.profiles, enrolledIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const notEnrolled = connected.filter((p) => !p.enrolled);
  const canStart = isHost && enrolled.length >= MIN_PLAYERS && notEnrolled.length === 0 && conflicts.length === 0 && stale.length === 0;

  const link = `${location.origin}${import.meta.env.BASE_URL}?room=${room.code}`;
  const share = async () => {
    try {
      if (navigator.share) await navigator.share({ title: 'Join my Lazer Shooter game', text: `Room code ${room.code}`, url: link });
      else {
        await navigator.clipboard.writeText(link);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      /* cancelled */
    }
  };

  const saveSettings = (patch: Partial<RoomSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void backend.updateMeta(room.code, { settings: next });
  };

  const soundCheck = () => {
    unlockAudio();
    sfx.fire();
    haptic();
  };

  // Starting applies the final settings to everyone, so a Lives change made after people joined counts.
  const start = () => {
    soundCheck();
    void backend.startRound(room.code, settings, backend.now() + 5000);
  };

  return (
    <div className="screen">
      <div className="lobby-head">
        <div>
          <div className="label">Room code</div>
          <div className="code">{room.code}</div>
        </div>
        <button className="btn" onClick={share}>
          {copied ? 'Copied!' : 'Share link'}
        </button>
      </div>

      {audio !== 'running' && (
        <button className="note warn sound-check" onClick={soundCheck}>
          {audio === 'none' ? 'Tap to enable sound and buzz' : 'Sound is blocked. Tap to turn it back on'}
        </button>
      )}

      <ShotReview room={room} pid={pid} />

      <h3>Players ({connected.length})</h3>
      <ul className="players">
        {players.map((p) => (
          <li key={p.id} className={p.connected ? '' : 'dim'}>
            <span className="dot" style={{ background: p.color }} />
            <span className="name">
              {p.name}
              {p.id === room.hostId && <small> host</small>}
              {p.id === pid && <small> you</small>}
            </span>
            <span className={`tag ${p.enrolled ? 'ok' : 'todo'}`}>{p.enrolled ? 'enrolled' : 'enrolling'}</span>
          </li>
        ))}
      </ul>

      {stale.map((p) => (
        <div key={p.id} className="note warn">
          {p.id === pid ? 'Your' : `${p.name}'s`} scan is from an older version of the game.{' '}
          {p.id === pid ? (
            <button className="link" onClick={() => backend.updatePlayer(room.code, me.id, { enrolled: false })}>
              Redo it now
            </button>
          ) : (
            'They need to redo it.'
          )}
        </div>
      ))}

      {faceAlike.map((c) => (
        <div key={'face' + c.a.id + c.b.id} className="note">
          {c.a.name} and {c.b.name} have faces the camera finds alike ({Math.round(c.sim * 100)}%). Hits between them will lean on outfits, so
          keep those clearly different.
        </div>
      ))}

      {conflicts.map((c) => (
        <div key={c.a.id + c.b.id} className="note bad">
          {c.a.name} and {c.b.name} are dressed too alike ({Math.round(c.sim * 100)}% match). One of them needs to change a top, trousers,
          or add a hat before the game can start.
        </div>
      ))}

      {isHost ? (
        <div className="settings">
          <h3>Rules</h3>
          <label>
            Lives <NumberField value={settings.lives} min={1} max={10} step={1} onCommit={(v) => saveSettings({ lives: v })} />
          </label>
          <label>
            Cooldown (ms) <NumberField value={settings.cooldownMs} min={200} max={10000} step={100} onCommit={(v) => saveSettings({ cooldownMs: v })} />
          </label>
          <label>
            Shield after hit (ms) <NumberField value={settings.invulnMs} min={0} max={30000} step={500} onCommit={(v) => saveSettings({ invulnMs: v })} />
          </label>
          <label>
            Hit confidence <NumberField value={settings.hitThreshold} min={0.2} max={0.95} step={0.05} onCommit={(v) => saveSettings({ hitThreshold: v })} />
          </label>
        </div>
      ) : (
        <p className="sub">
          {settings.lives} lives, {settings.cooldownMs / 1000}s cooldown, {settings.invulnMs / 1000}s shield after a hit.
        </p>
      )}

      <div className="lobby-actions">
        {isHost ? (
          <button className="btn primary big" disabled={!canStart} onClick={start}>
            Start game
          </button>
        ) : (
          <p className="sub">Waiting for {room.players[room.hostId]?.name ?? 'the host'} to start.</p>
        )}
        {isHost && !canStart && (
          <p className="hint">
            {enrolled.length < MIN_PLAYERS
              ? `Need at least ${MIN_PLAYERS} enrolled players.`
              : notEnrolled.length > 0
                ? `Waiting for ${notEnrolled.map((p) => p.name).join(', ')} to enroll.`
                : stale.length > 0
                  ? 'Someone needs to redo an outdated scan.'
                  : 'Resolve the clothing conflict above.'}
          </p>
        )}
        <div className="row">
          <button className="link" onClick={() => backend.updatePlayer(room.code, me.id, { enrolled: false })}>
            Redo my enrollment
          </button>
          <button className="link" onClick={onLeave}>
            Leave room
          </button>
        </div>
      </div>
    </div>
  );
}

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}

/** Numeric input that lets the host clear and retype freely, then clamps and saves once on blur or Enter. */
function NumberField({ value, min, max, step, onCommit }: NumberFieldProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!Number.isFinite(n) || text.trim() === '') {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}
