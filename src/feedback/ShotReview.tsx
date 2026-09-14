import { useEffect, useRef, useState } from 'react';
import { backend } from '../net';
import type { Room } from '../types';
import { feedbackStore, type StoredRound, type StoredShot } from './store';
import { pickReviewShot, REVIEWABLE_OUTCOMES, trimSample, type ShotLabel } from './sample';
import { IdMap } from './sample';

interface Props {
  room: Room;
  pid: string;
}

type State =
  | { phase: 'loading' }
  | { phase: 'idle' }
  | { phase: 'ask'; round: StoredRound; shot: StoredShot; shownAt: number }
  | { phase: 'done'; round: StoredRound; remaining: number; uploaded: boolean | null };

const SAID: Record<string, string> = { unclear: 'UNCLEAR TARGET', miss: 'MISS', 'stale frame': 'CAMERA TOO SLOW' };
/** Firebase writes never reject while offline, they wait; past this the upload is queued and retried later instead. */
const UPLOAD_TIMEOUT_MS = 6000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const tm = setTimeout(() => reject(new Error('upload timed out')), ms);
    p.then((v) => {
      clearTimeout(tm);
      resolve(v);
    }, (e: unknown) => {
      clearTimeout(tm);
      reject(e);
    });
  });
}

const fmtRound = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * After a round, one of the shooter's failed shots is shown as a photo with the crosshair, and they
 * say whether it should have counted and on whom. The answer, with the numbers behind the shot,
 * is uploaded; the photo is deleted. Rendered on the results screen and again in the lobby, so the
 * host moving on does not take the card away before a guest has answered.
 */
export function ShotReview({ room, pid }: Props) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [url, setUrl] = useState<string | null>(null);
  const alive = useRef(true);

  const load = async (): Promise<void> => {
    const pending = await feedbackStore.pendingReview();
    if (!alive.current) return;
    if (!pending || pending.round.code !== room.code) return setState({ phase: 'idle' });
    const shot = pickReviewShot(pending.shots);
    if (!shot) {
      await feedbackStore.finishReview(pending.round.key);
      return setState({ phase: 'idle' });
    }
    setState({ phase: 'ask', round: pending.round, shot, shownAt: Date.now() });
  };

  useEffect(() => {
    alive.current = true;
    void load();
    // Samples that could not be uploaded last time (no connection at the venue) go out now.
    void feedbackStore.flush((u) => withTimeout(backend.submitShotFeedback(u.round, u.sample, u.profiles), UPLOAD_TIMEOUT_MS));
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.code]);

  // The photo is shown from an object URL that is released as soon as the card moves on.
  useEffect(() => {
    if (state.phase !== 'ask' || !state.shot.photo) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(state.shot.photo);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [state]);

  if (state.phase === 'loading' || state.phase === 'idle') return null;

  const finishIfEmpty = async (round: StoredRound): Promise<number> => {
    const pending = await feedbackStore.pendingReview();
    const remaining = pending && pending.round.key === round.key ? pending.shots.filter((s) => REVIEWABLE_OUTCOMES.has(s.outcome)).length : 0;
    if (remaining === 0) await feedbackStore.finishReview(round.key);
    return remaining;
  };

  const answer = async (round: StoredRound, shot: StoredShot, label: ShotLabel | null) => {
    setState({ phase: 'loading' });
    let uploaded: boolean | null = null;
    if (label) {
      const sample = trimSample({ ...shot.sample, label });
      try {
        await withTimeout(backend.submitShotFeedback(round.key, sample, round.profiles), UPLOAD_TIMEOUT_MS);
        uploaded = true;
      } catch (e) {
        console.warn('feedback upload deferred', e);
        await feedbackStore.enqueue({ id: shot.id, round: round.key, sample, profiles: round.profiles });
        uploaded = false;
      }
    }
    await feedbackStore.deleteShot(shot.id);
    const remaining = await finishIfEmpty(round);
    if (alive.current) setState({ phase: 'done', round, remaining, uploaded });
  };

  const skip = async (round: StoredRound) => {
    setState({ phase: 'loading' });
    await feedbackStore.finishReview(round.key);
    if (alive.current) setState({ phase: 'idle' });
  };

  if (state.phase === 'done') {
    return (
      <div className="review done">
        <div className="label">Shot review</div>
        <p className="sub">
          {state.uploaded === null ? 'Skipped that one.' : state.uploaded ? 'Thanks. That answer helps tune the tracking.' : 'Thanks. Saved; it uploads when the phone is back online.'}
        </p>
        {state.remaining > 0 && (
          <button className="link" onClick={() => void load()}>
            Review another shot ({state.remaining} left)
          </button>
        )}
      </div>
    );
  }

  const { round, shot, shownAt } = state;
  const ids = new IdMap(round.ids);
  const others = round.ids.filter((id) => id !== pid);
  const name = (id: string) => room.players[id]?.name ?? `Player ${ids.pid(id).slice(1)}`;
  const label = (kind: ShotLabel['kind'], target?: string): ShotLabel => {
    const base = { answeredAt: Date.now(), reviewMs: Date.now() - shownAt };
    return kind === 'player' ? { kind, target: ids.pid(target!), ...base } : { kind: 'none', ...base };
  };

  return (
    <div className="review">
      <div className="label">Shot review</div>
      <p className="prompt">Did you clearly shoot another player when you did this shot?</p>
      {url ? <img className="review-photo" src={url} alt="The camera frame at the moment you fired, with the crosshair" /> : <p className="sub">No photo was kept for this shot.</p>}
      <p className="hint">
        {fmtRound(shot.roundMs)} into the round. The phone said {SAID[shot.outcome] ?? shot.outcome.toUpperCase()}. Count it only if their head or body was in the crosshair; an arm or a leg does not count.
      </p>
      <div className="review-answers">
        {others.map((id) => (
          <button key={id} className="btn" onClick={() => void answer(round, shot, label('player', id))}>
            <span className="dot" style={{ background: room.players[id]?.color ?? '#8892a6' }} />
            Yes, I shot {name(id)}
          </button>
        ))}
        <button className="btn none" onClick={() => void answer(round, shot, label('none'))}>
          No, this should not count
        </button>
        <button className="btn" onClick={() => void answer(round, shot, null)}>
          I can't tell from this photo
        </button>
      </div>
      <div className="review-foot">
        <span className="tag">Only the numbers behind the shot are uploaded, never the photo.</span>
        <button className="link" onClick={() => void skip(round)}>
          Skip
        </button>
      </div>
    </div>
  );
}
