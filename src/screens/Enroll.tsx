import { backend } from '../net';
import type { DeepProfile, Player } from '../types';
import { FACE_MODEL } from '../vision/human';
import { Scanner } from './Scanner';

interface Props {
  code: string;
  pid: string;
  me: Player;
  /** Signed-in players bring their one-time scan, so only the outfit is captured here. */
  deep?: DeepProfile | null;
  onLeave: () => void;
}

/** Per-room enrollment. Guests do the full scan; account holders with a current deep scan do the outfit only. */
export function Enroll({ code, pid, me, deep, onLeave }: Props) {
  const useDeep = Boolean(deep && deep.faceModel === FACE_MODEL && deep.face.length > 0);
  return (
    <Scanner
      face={!useDeep}
      body
      outfit
      header={
        <span className="chip" style={{ background: me.color }}>
          {me.name}
        </span>
      }
      savingText={useDeep ? 'Uploading your outfit for this game.' : 'Uploading your face, outfit, and body signature.'}
      onCancel={onLeave}
      onDone={async (r) => {
        if (!r.outfit) throw new Error('Outfit scan missing');
        await backend.setProfile(code, pid, {
          faceModel: FACE_MODEL,
          face: useDeep ? deep!.face : r.face,
          outfit: r.outfit,
          // Fresh ratios from today's frames, falling back to the stored ones.
          body: r.body ?? deep?.body ?? null,
        });
      }}
    />
  );
}
