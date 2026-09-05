import { useEffect } from 'react';
import { backend } from '../net';
import type { Room } from '../types';
import { sfx } from '../audio/sfx';

interface Props {
  room: Room;
  pid: string;
  onLeave: () => void;
}

export function Results({ room, pid, onLeave }: Props) {
  const isHost = room.hostId === pid;
  const winner = room.winnerId ? room.players[room.winnerId] : null;
  useEffect(() => {
    sfx.gameOver();
  }, []);

  const standings = Object.values(room.players)
    .filter((p) => p.enrolled)
    .sort((a, b) => {
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
            <span className="tag">{p.status === 'alive' ? `${p.lives} ♥` : 'out'}</span>
          </li>
        ))}
      </ol>
      {isHost ? (
        <button className="btn primary big" onClick={() => backend.resetForNewRound(room.code)}>
          Back to lobby
        </button>
      ) : (
        <p className="sub">Waiting for the host to start another round.</p>
      )}
      <button className="link" onClick={onLeave}>
        Leave room
      </button>
    </div>
  );
}
