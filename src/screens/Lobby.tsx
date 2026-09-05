import { useEffect, useState } from 'react';
import { backend } from '../net';
import { CLOTHING_CONFLICT, type Player, type Room, type RoomSettings } from '../types';
import { torsoConflict } from '../vision/clothing';
import { unlockAudio } from '../audio/sfx';

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
  useEffect(() => setSettings(room.settings), [room.settings]);

  const players = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
  const connected = players.filter((p) => p.connected);
  const enrolled = connected.filter((p) => p.enrolled && room.profiles[p.id]);

  const conflicts: { a: Player; b: Player; sim: number }[] = [];
  for (let i = 0; i < enrolled.length; i++) {
    for (let j = i + 1; j < enrolled.length; j++) {
      const sim = torsoConflict(room.profiles[enrolled[i].id].torso, room.profiles[enrolled[j].id].torso);
      if (sim > CLOTHING_CONFLICT) conflicts.push({ a: enrolled[i], b: enrolled[j], sim });
    }
  }

  const minPlayers = backend.mode === 'local' ? 1 : 2;
  const notEnrolled = connected.filter((p) => !p.enrolled);
  const canStart = isHost && enrolled.length >= minPlayers && notEnrolled.length === 0 && conflicts.length === 0;

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

  const start = () => {
    unlockAudio();
    void backend.updateMeta(room.code, { status: 'countdown', startAt: backend.now() + 5000, settings });
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

      {conflicts.map((c) => (
        <div key={c.a.id + c.b.id} className="note bad">
          {c.a.name} and {c.b.name} are wearing tops that look too alike ({Math.round(c.sim * 100)}% match). One of them needs to change
          before the game can start.
        </div>
      ))}

      {isHost ? (
        <div className="settings">
          <h3>Rules</h3>
          <label>
            Lives <input type="number" min={1} max={10} value={settings.lives} onChange={(e) => saveSettings({ lives: +e.target.value || 1 })} />
          </label>
          <label>
            Cooldown (ms){' '}
            <input type="number" min={200} step={100} value={settings.cooldownMs} onChange={(e) => saveSettings({ cooldownMs: +e.target.value || 1000 })} />
          </label>
          <label>
            Shield after hit (ms){' '}
            <input type="number" min={0} step={500} value={settings.invulnMs} onChange={(e) => saveSettings({ invulnMs: +e.target.value || 0 })} />
          </label>
          <label>
            Hit confidence{' '}
            <input type="number" min={0.2} max={0.95} step={0.05} value={settings.hitThreshold} onChange={(e) => saveSettings({ hitThreshold: +e.target.value || 0.5 })} />
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
            {enrolled.length < minPlayers
              ? `Need at least ${minPlayers} enrolled players.`
              : notEnrolled.length > 0
                ? `Waiting for ${notEnrolled.map((p) => p.name).join(', ')} to enroll.`
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
