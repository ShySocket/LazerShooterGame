import { useState } from 'react';
import { backend } from '../net';
import { unlockAudio } from '../audio/sfx';

interface Props {
  initialCode: string;
  onCreate: (name: string) => Promise<void>;
  onJoin: (name: string, code: string) => Promise<void>;
}

export function Home({ initialCode, onCreate, onJoin }: Props) {
  const [name, setName] = useState(localStorage.getItem('lz:name') ?? '');
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
      {err && <div className="note bad">{err}</div>}
    </div>
  );
}
