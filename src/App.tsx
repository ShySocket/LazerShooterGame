import { useEffect, useState } from 'react';
import { backend } from './net';
import { authAvailable, loadUser, onAccount, saveUserName, type Account } from './net/auth';
import type { DeepProfile, Room } from './types';
import { Home } from './screens/Home';
import { Enroll } from './screens/Enroll';
import { Lobby } from './screens/Lobby';
import { Game } from './screens/Game';
import { Results } from './screens/Results';
import { Profile } from './screens/Profile';
import { loadHuman } from './vision/human';
import { applyPendingUpdate, onUpdatePending, updatePending } from './pwa';

function guestPid(): string {
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
  // Signed-in players use their account id everywhere, so the same person can play from any phone.
  const [account, setAccount] = useState<Account | null | undefined>(authAvailable ? undefined : null);
  const [deep, setDeep] = useState<DeepProfile | null>(null);
  const [deepLoaded, setDeepLoaded] = useState(!authAvailable);
  const [showProfile, setShowProfile] = useState(false);
  const pid = account ? account.uid : guestPid();
  const [code, setCode] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [swPending, setSwPending] = useState(updatePending());

  useEffect(() => onAccount(setAccount, setNotice), []);
  useEffect(() => onUpdatePending(() => setSwPending(true)), []);
  // A new build is applied only while nobody is mid-scan or mid-round on this phone.
  useEffect(() => {
    if (swPending && !code && !showProfile) applyPendingUpdate();
  }, [swPending, code, showProfile]);
  // Models are ~24 MB; start fetching while the player is still typing a name.
  useEffect(() => {
    void loadHuman().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!account) {
      setDeep(null);
      setDeepLoaded(true);
      return;
    }
    let cancelled = false;
    setDeepLoaded(false);
    loadUser(account.uid)
      .then((u) => {
        if (cancelled) return;
        setDeep(u?.deep ?? null);
        if (!u?.name) void saveUserName(account.uid, account.name);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setDeepLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    if (!code) {
      setRoom(undefined);
      return;
    }
    setRoom(undefined);
    return backend.subscribe(code, setRoom);
  }, [code]);

  const enter = (c: string) => {
    setCode(c);
    history.replaceState(null, '', `${location.pathname}?room=${c}`);
  };
  const leave = () => {
    if (code) void backend.leaveRoom(code, pid).catch(() => undefined);
    setCode(null);
    history.replaceState(null, '', location.pathname);
  };

  if (account === undefined || !deepLoaded) return <Notice text="Connecting" />;

  if (showProfile && account) {
    return <Profile account={account} deep={deep} onDeepChange={setDeep} onBack={() => setShowProfile(false)} />;
  }

  if (!code) {
    return (
      <Home
        initialCode={codeFromUrl()}
        account={account}
        deep={deep}
        notice={notice}
        onProfile={() => {
          void loadHuman();
          setShowProfile(true);
        }}
        onCreate={async (name) => enter(await backend.createRoom({ id: pid, name }))}
        onJoin={async (name, c) => {
          const r = await backend.joinRoom(c, { id: pid, name });
          if (r === 'missing') throw new Error(`Room ${c} was not found`);
          if (r === 'in-progress') throw new Error(`Room ${c} is mid-game. Ask the host to share the link again once they are back in the lobby.`);
          enter(c);
        }}
      />
    );
  }
  if (room === undefined) return <Notice text="Connecting" />;
  if (room === null) return <Notice text="This room no longer exists." onBack={leave} />;
  const me = room.players[pid];
  if (!me) return <Notice text="You are not in this room." onBack={leave} />;
  if (!me.enrolled) return <Enroll code={code} pid={pid} me={me} deep={deep} onLeave={leave} />;
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
