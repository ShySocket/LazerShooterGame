import { useEffect, useState } from 'react';
import { backend } from './net';
import type { Room } from './types';
import { Home } from './screens/Home';
import { Enroll } from './screens/Enroll';
import { Lobby } from './screens/Lobby';
import { Game } from './screens/Game';
import { Results } from './screens/Results';
import { loadHuman } from './vision/human';

function getPid(): string {
  let v = localStorage.getItem('lz:pid');
  if (!v) {
    v = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    localStorage.setItem('lz:pid', v);
  }
  return v;
}

function codeFromUrl(): string {
  return (new URL(location.href).searchParams.get('room') ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

export default function App() {
  const [pid] = useState(getPid);
  const [code, setCode] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null | undefined>(undefined);

  useEffect(() => {
    if (!code) {
      setRoom(undefined);
      return;
    }
    setRoom(undefined);
    // Start pulling models as soon as we are in a room so enrollment does not wait.
    void loadHuman();
    return backend.subscribe(code, setRoom);
  }, [code]);

  const enter = (c: string) => {
    setCode(c);
    history.replaceState(null, '', `${location.pathname}?room=${c}`);
  };
  const leave = () => {
    setCode(null);
    history.replaceState(null, '', location.pathname);
  };

  if (!code) {
    return (
      <Home
        initialCode={codeFromUrl()}
        onCreate={async (name) => enter(await backend.createRoom({ id: pid, name }))}
        onJoin={async (name, c) => {
          if (!(await backend.joinRoom(c, { id: pid, name }))) throw new Error(`Room ${c} was not found`);
          enter(c);
        }}
      />
    );
  }
  if (room === undefined) return <Notice text="Connecting" />;
  if (room === null) return <Notice text="This room no longer exists." onBack={leave} />;
  const me = room.players[pid];
  if (!me) return <Notice text="You are not in this room." onBack={leave} />;
  if (!me.enrolled) return <Enroll code={code} pid={pid} me={me} onLeave={leave} />;
  switch (room.status) {
    case 'lobby':
      return <Lobby room={room} me={me} pid={pid} onLeave={leave} />;
    case 'countdown':
    case 'playing':
      return <Game room={room} me={me} pid={pid} onLeave={leave} />;
    case 'ended':
      return <Results room={room} pid={pid} onLeave={leave} />;
  }
}

function Notice({ text, onBack }: { text: string; onBack?: () => void }) {
  return (
    <div className="screen center">
      <p className="sub">{text}</p>
      {onBack && (
        <button className="btn" onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}
