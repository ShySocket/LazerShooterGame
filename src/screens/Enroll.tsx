import { backend } from '../net';
import { BODY_MODEL, type DeepProfile, type Player } from '../types';
import { FACE_MODEL, isCurrentFaceScan } from '../vision/human';
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
  const useDeep = isCurrentFaceScan(deep);
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
      referenceFace={useDeep ? deep!.face[0] : undefined}
      onCancel={onLeave}
      onDone={async (r) => {
        if (!r.outfit) throw new Error('Outfit scan missing');
        await backend.setProfile(code, pid, {
          faceModel: FACE_MODEL,
          bodyModel: BODY_MODEL,
          // Close selfie angles plus the samples taken from metres away during the body scan.
          face: [...(useDeep ? deep!.face : r.face), ...r.farFace],
          outfit: r.outfit,
          // Use current-frame ratios; older saved scans may use a different geometry convention.
          body: r.body ?? null,
        });
      }}
    />
  );
}
