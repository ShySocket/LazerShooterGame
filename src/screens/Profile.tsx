import { useState } from 'react';
import { clearDeep, saveDeep, signOut, type Account } from '../net/auth';
import type { DeepProfile } from '../types';
import { FACE_MODEL } from '../vision/human';
import { Scanner } from './Scanner';

interface Props {
  account: Account;
  deep: DeepProfile | null;
  onDeepChange: (d: DeepProfile | null) => void;
  onBack: () => void;
}

/** Account page: run or redo the one-time deep scan, or sign out. */
export function Profile({ account, deep, onDeepChange, onBack }: Props) {
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = deep && deep.faceModel === FACE_MODEL;

  if (scanning) {
    return (
      <Scanner
        face
        body
        outfit={false}
        header={<span className="chip account-chip">{account.name}</span>}
        savingText="Saving your scan to your account."
        onCancel={() => setScanning(false)}
        onDone={async (r) => {
          const d: DeepProfile = { faceModel: FACE_MODEL, face: r.face, body: r.body, updatedAt: Date.now() };
          await saveDeep(account.uid, account.name, d);
          onDeepChange(d);
          setScanning(false);
        }}
      />
    );
  }

  return (
    <div className="screen">
      <div className="lobby-head">
        <div>
          <div className="label">Signed in as</div>
          <h2>{account.name}</h2>
          {account.email && <p className="sub">{account.email}</p>}
        </div>
        <button className="link" onClick={onBack}>
          Back
        </button>
      </div>

      <h3>Your scan</h3>
      {current ? (
        <div className="note ok">
          Deep scan saved {new Date(deep!.updatedAt).toLocaleDateString()} with {deep!.face.length} face angles
          {deep!.body ? ' and body ratios' : ''}. In every game you only scan your outfit.
        </div>
      ) : deep ? (
        <div className="note warn">Your scan was made with an older version of the game. Redo it once to skip face scans in games.</div>
      ) : (
        <div className="note warn">No scan yet. Do it once, about a minute, and you will never scan your face in a game again.</div>
      )}
      <p className="sub">
        The scan stores 8 face angles and your body proportions as numbers, never photos. It works on any phone you sign into.
      </p>
      <button className="btn primary big" onClick={() => setScanning(true)}>
        {current ? 'Redo deep scan' : 'Start deep scan'}
      </button>
      {deep && (
        <button
          className="link"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await clearDeep(account.uid);
            onDeepChange(null);
            setBusy(false);
          }}
        >
          Delete my scan
        </button>
      )}

      <div className="lobby-actions">
        <button className="link" disabled={busy} onClick={() => void signOut().then(onBack)}>
          Sign out
        </button>
      </div>
    </div>
  );
}
