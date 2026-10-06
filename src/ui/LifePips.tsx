/** Lives drawn as the HUD draws them, small enough for a list row; the label carries the count for screen readers. */
export function LifePips({ lives, max }: { lives: number; max: number }) {
  return (
    <span className="pips" role="img" aria-label={`${lives} ${lives === 1 ? 'life' : 'lives'} left`}>
      {Array.from({ length: Math.max(max, lives) }, (_, i) => (
        <span key={i} className={i < lives ? 'on' : 'off'} />
      ))}
    </span>
  );
}
