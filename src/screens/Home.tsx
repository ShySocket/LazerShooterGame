import { useEffect, useState } from 'react';
import { backend } from '../net';
import { authAvailable, signInGoogle, type Account } from '../net/auth';
import type { DeepProfile } from '../types';
import { FACE_MODEL } from '../vision/human';
import { haptic, sfx, unlockAudio } from '../audio/sfx';

interface Props {
  initialCode: string;
  account: Account | null;
  deep: DeepProfile | null;
  /** A message from outside the screen, e.g. a sign-in that failed to complete. */
  notice?: string | null;
  onProfile: () => void;
  onCreate: (name: string) => Promise<void>;
  onJoin: (name: string, code: string) => Promise<void>;
}

export function Home({ initialCode, account, deep, notice, onProfile, onCreate, onJoin }: Props) {
  const [name, setName] = useState(account?.name ?? localStorage.getItem('lz:name') ?? '');
  useEffect(() => {
    if (account) setName(account.name);
  }, [account]);
  const scanReady = Boolean(deep && deep.faceModel === FACE_MODEL);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    unlockAudio();
    const n = name.trim();
    if (!n) {
      setErr('Enter a name first');
      return;
    }
    sfx.tick();
    haptic();
    localStorage.setItem('lz:name', n);
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen center">
      <h1 className="title">
        LAZER<span>SHOOTER</span>
      </h1>
      <p className="sub">Real-life laser tag. Your phone is the gun.</p>
      {backend.mode === 'local' && (
        <div className="note warn">
          Local mode: no Firebase config found, so this device plays alone. See README to enable multiplayer.
        </div>
      )}
      {authAvailable && !account && (
        <button
          className="btn google-btn"
          disabled={busy}
          onClick={() => {
            unlockAudio();
            void signInGoogle().catch((e) => setErr(e instanceof Error ? e.message : String(e)));
          }}
        >
          <GoogleMark /> Sign in with Google
        </button>
      )}
      {account && (
        <button className="account-row" onClick={onProfile}>
          {account.photo ? <img src={account.photo} alt="" referrerPolicy="no-referrer" /> : <span className="dot" style={{ background: 'var(--good)' }} />}
          <span className="name">{account.name}</span>
          <span className={`tag ${scanReady ? 'ok' : 'todo'}`}>{scanReady ? 'scan saved' : 'set up scan'}</span>
        </button>
      )}
      {account && !scanReady && (
        <p className="hint">Do your one-time deep scan now so games only need an outfit scan.</p>
      )}
      <label className="field">
        <span>Your name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={16} placeholder="e.g. Sam" autoComplete="off" />
      </label>
      <button className="btn primary" disabled={busy} onClick={() => run(() => onCreate(name.trim()))}>
        Create a room
      </button>
      <div className="divider">or join one</div>
      <div className="row">
        <input
          className="code-input"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4))}
          placeholder="CODE"
          autoCapitalize="characters"
          autoComplete="off"
        />
        <button className="btn" disabled={busy || code.length !== 4} onClick={() => run(() => onJoin(name.trim(), code))}>
          Join
        </button>
      </div>
      {(err ?? notice) && <div className="note bad">{err ?? notice}</div>}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" />
      <path fill="#FBBC05" d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.3 0 11.7-2.1 15.6-5.7l-7.7-6c-2.1 1.4-4.8 2.3-7.9 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
