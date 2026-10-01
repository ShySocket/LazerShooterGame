import { useState } from 'react';
import type { Room } from '../types';
import { practiceBackend } from '../net';
import { useCamera } from '../hooks/useCamera';
import { enrolFromCanvases, grabFrame } from '../vision/quickEnrol';
import { practiceCaptureNote } from '../ui/advice';

/** Frames taken per capture and the gap between them: about two seconds of the person moving a little. */
const CAPTURE_FRAMES = 12;
const CAPTURE_GAP_MS = 170;

/**
 * Practice lobby: add targets without their phones. Point the rear camera at a friend, a TV or a
 * photo and tap Capture; the largest person in view is enrolled (quickEnrol) as "Target n".
 */
export function PracticeTargets({ room }: { room: Room }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cam = useCamera('environment', open);
  const targets = Object.values(room.players).filter((p) => p.id.startsWith('target-') && p.connected);

  const capture = async () => {
    const video = cam.videoRef.current;
    if (!practiceBackend || !video) return;
    setBusy(true);
    setNote('Hold still on them…');
    try {
      const frames: HTMLCanvasElement[] = [];
      for (let i = 0; i < CAPTURE_FRAMES; i++) {
        const f = grabFrame(video);
        if (f) frames.push(f);
        await new Promise((r) => setTimeout(r, CAPTURE_GAP_MS));
      }
      setNote('Reading the face and outfit…');
      const r = await enrolFromCanvases(frames);
      const name = `Target ${targets.length + 1}`;
      await practiceBackend.addTarget(room.code, name, r.profile);
      setNote(practiceCaptureNote(name, r.faces, r.frames, r.outfit));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="practice-targets">
      <h3>Practice targets ({targets.length})</h3>
      <ul className="players">
        {targets.map((t) => (
          <li key={t.id}>
            <span className="dot" style={{ background: t.color }} />
            <span className="name">{t.name}</span>
            <button className="link" onClick={() => void practiceBackend?.removeTarget(room.code, t.id)}>
              remove
            </button>
          </li>
        ))}
      </ul>
      {open ? (
        <div className="capture">
          <video ref={cam.videoRef} playsInline muted autoPlay className="capture-video" />
          {cam.error && <p className="note bad">{cam.error}</p>}
          <div className="row">
            <button className="btn primary" disabled={!cam.ready || busy} onClick={() => void capture()}>
              {busy ? 'Capturing…' : 'Capture'}
            </button>
            <button className="btn" disabled={busy} onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" onClick={() => setOpen(true)}>
          Add a target
        </button>
      )}
      <p className="hint">{note ?? 'Point the back camera at a friend, a TV or a photo, face on, whole body in view if you can, then tap Capture.'}</p>
    </div>
  );
}
