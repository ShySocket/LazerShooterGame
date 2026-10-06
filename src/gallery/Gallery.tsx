import { Notice } from '../App';
import { Profile } from '../screens/Profile';
import { Scanner } from '../screens/Scanner';
import { FACE_MODEL } from '../vision/human';
import { BODY_MODEL, type DeepProfile } from '../types';

/**
 * ?gallery=<state> (dev builds only): screens a two-phone round cannot reach, for the UI screenshot
 * tour (tests/ui/tour.spec.ts): waits, the crash screen, the account page and the body scan.
 */
const account = { uid: 'gallery', name: 'Sai', email: 'sai@example.com', photo: null } as const;
const deep: DeepProfile = {
  faceModel: FACE_MODEL,
  bodyModel: BODY_MODEL,
  face: Array.from({ length: 8 }, () => [0]),
  body: null,
  updatedAt: Date.UTC(2026, 9, 6),
} as unknown as DeepProfile;

function Crash(): never {
  throw new Error('Cannot read properties of undefined (reading "players")');
}

export function Gallery({ state }: { state: string }) {
  const noop = () => undefined;
  switch (state) {
    case 'notice':
      return <Notice text="Connecting to the room" />;
    case 'notice-slow':
      return <Notice text="Still connecting. Check your Wi-Fi or go back and try again." onBack={noop} />;
    case 'crash':
      return <Crash />;
    case 'profile':
      return <Profile account={account as never} deep={null} onDeepChange={noop} onBack={noop} />;
    case 'profile-saved':
      return <Profile account={account as never} deep={deep} onDeepChange={noop} onBack={noop} />;
    case 'body':
      return <Scanner face={false} body outfit header={<span className="chip" style={{ background: '#3bd5ff' }}>Sai</span>} onDone={async () => undefined} onCancel={noop} />;
    default:
      return <Notice text={`Unknown gallery state "${state}"`} />;
  }
}
