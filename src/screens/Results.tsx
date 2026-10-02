import { useEffect, useState } from 'react';
import { backend } from '../net';
import { enrolledPlayers, livesLabel, type Room } from '../types';
import { sfx } from '../audio/sfx';
import { shotLog } from '../debug/shotLog';
import { ShotReview } from '../feedback/ShotReview';
import { PracticeReview } from '../feedback/PracticeReview';
import { RESET_FAILED } from '../ui/advice';

interface Props {
  room: Room;
  pid: string;
  onLeave: () => void;
}

export function Results({ room, pid, onLeave }: Props) {
  const isHost = room.hostId === pid;
  const winner = room.winnerId ? room.players[room.winnerId] : null;
  const [showLog, setShowLog] = useState(false);
  const [resetNote, setResetNote] = useState('');
  const shots = shotLog.all();
  useEffect(() => {
    sfx.gameOver();
  }, []);
  const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });

  const standings = enrolledPlayers(room).sort((a, b) => {
    if (a.status !== b.status) return a.status === 'alive' ? -1 : 1;
    return (b.eliminatedAt ?? 0) - (a.eliminatedAt ?? 0);
  });

  return (
    <div className="screen center">
      <div className="label">Game over</div>
      <h1 className="title">{winner ? `${winner.name} wins` : 'No survivors'}</h1>
      {winner?.id === pid && <p className="sub">That is you. Nice shooting.</p>}
      <ol className="standings">
        {standings.map((p, i) => (
          <li key={p.id}>
            <span className="rank">{i + 1}</span>
            <span className="dot" style={{ background: p.color }} />
            <span className="name">{p.name}</span>
            <span className="tag">{p.tags} tags</span>
            <span className="tag">{livesLabel(p)}</span>
          </li>
        ))}
      </ol>
      <ShotReview room={room} pid={pid} />
      <PracticeReview />
      {isHost ? (
        <>
          {/* Names the round it ends: a tap replayed after another host moved on changes nothing. */}
          <button className="btn primary big" onClick={() => backend.resetForNewRound(room.code, room.startAt ?? null).then(() => setResetNote(''), () => setResetNote(RESET_FAILED))}>
            Back to lobby
          </button>
          {resetNote && <div className="note bad">{resetNote}</div>}
        </>
      ) : (
        <p className="sub">Waiting for the host to start another round.</p>
      )}
      <button className="link" onClick={onLeave}>
        Leave room
      </button>
      {shots.length > 0 && (
        <button className="link" onClick={() => setShowLog((v) => !v)}>
          {showLog ? 'Hide' : 'Show'} my shot log ({shots.length})
        </button>
      )}
      {showLog && (
        <ol className="shot-log">
          {shots.map((s, i) => (
            <li key={i}>
              <div className="shot-head">
                <span className="tag">{fmt(s.t)}</span>
                <span className={`shot-outcome ${s.outcome}`}>{s.outcome.toUpperCase()}</span>
                {s.targetName && <span className="name">{s.targetName}</span>}
                {s.via && <span className="tag">via {s.via}</span>}
                {s.resolveMs !== undefined && <span className="tag">{s.resolveMs}ms{s.zoom ? ' zoom' : ''}</span>}
                {s.refusal && <span className="tag">refused: {s.refusal}</span>}
              </div>
              {s.beliefs.length > 0 && (
                <div className="shot-beliefs">
                  {s.beliefs.map((b) => (
                    <span key={b.id} className="tag">
                      {b.name} {Math.round(b.score * 100)}%
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
