import { useEffect, useMemo, useState } from 'react';
import { feedbackStore, type StoredRound, type StoredShot } from './store';
import { practiceConditionsText, practiceReviewCounts, type PracticeFilter } from '../ui/advice';

/** Shots shown at first; the rest one tap away, so a long session does not decode 150 photos at once. */
const PAGE = 12;

const FILTERS: { id: PracticeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'bad', label: 'Wrong' },
  { id: 'warn', label: 'No lock' },
  { id: 'good', label: 'Right' },
];

/**
 * After a practice round: every shot with the frame it was decided on (the crosshair drawn where it
 * was), what the game said, and what the shooter said they aimed at and how. The photos never leave
 * the phone; the numbers behind each shot were uploaded at the tap. A wrong hit here is the thing to
 * look at first: the photo shows who was really under the dot.
 */
export function PracticeReview() {
  const [data, setData] = useState<{ round: StoredRound; shots: StoredShot[] } | null>(null);
  const [filter, setFilter] = useState<PracticeFilter>('all');
  const [shown, setShown] = useState(PAGE);
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void feedbackStore.practiceShots().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, []);

  const shots = useMemo(() => (data?.shots ?? []).filter((s) => filter === 'all' || s.practice?.kind === filter), [data, filter]);
  const visible = shots.slice(0, shown);

  // Object URLs for the photos on screen, released when they scroll out of the list or the card closes.
  useEffect(() => {
    const made: Record<string, string> = {};
    for (const s of visible) if (s.photo) made[s.id] = URL.createObjectURL(s.photo);
    setUrls(made);
    return () => Object.values(made).forEach((u) => URL.revokeObjectURL(u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((s) => s.id).join(',')]);

  if (!data) return null;
  const counts = practiceReviewCounts(data.shots.map((s) => s.practice?.kind));

  return (
    <section className="practice-review" aria-label="Practice review">
      <h3>Practice review</h3>
      <p className="sub">
        {counts.total} shots: {counts.good} right, {counts.bad} wrong, {counts.warn} no lock. Photos stay on this phone; only the numbers were uploaded.
      </p>
      <div className="row chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} className={`chip-btn ${filter === f.id ? 'on' : ''}`} aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setShown(PAGE); }}>
            {f.label}
          </button>
        ))}
      </div>
      <ol className="practice-shots">
        {visible.map((s) => (
          <li key={s.id} className={`practice-shot ${s.practice?.kind ?? ''}`}>
            {urls[s.id] ? <img src={urls[s.id]} alt={`Frame of the shot: ${s.practice?.verdict ?? s.outcome}`} /> : <div className="no-photo">no photo</div>}
            <div>
              <div className={`verdict ${s.practice?.kind ?? ''}`}>{s.practice?.verdict ?? s.outcome}</div>
              <div className="tag">{practiceConditionsText(s.practice?.aimed ?? '?', s.sample.label ?? {}, s.practice?.resolveMs ?? null)}</div>
            </div>
          </li>
        ))}
      </ol>
      {shots.length > shown && (
        <button className="link" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, shots.length - shown)} more
        </button>
      )}
      {shots.length === 0 && <p className="hint">No shots here.</p>}
      <button
        className="link"
        onClick={() => {
          void feedbackStore.clearPractice(data.round.key).then(() => setData(null));
        }}
      >
        Delete these photos
      </button>
    </section>
  );
}
