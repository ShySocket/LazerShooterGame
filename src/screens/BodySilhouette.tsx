/**
 * The body-scan progress as a neon figure over the preview: it fills from the feet up as outfit
 * samples land, turns to a back view for the back stage, and the dots over its head light one per
 * face sample during the far-face wait (big enough to read from where the player stands).
 */

const BODY =
  'M 43 38 L 43 44 C 31 46 23 50 21 60 L 14 112 C 13 118 20 120 22 114 L 30 72 L 32 120 L 30 208 C 30 215 44 215 44 208 L 48 140 L 52 140 L 56 208 C 56 215 70 215 70 208 L 68 120 L 70 72 L 78 114 C 80 120 87 118 86 112 L 79 60 C 77 50 69 46 57 44 L 57 38 Z';
const H = 218;

interface Props {
  side: 'front' | 'back';
  /** Outfit samples, 0..1. */
  progress: number;
  /** Far-face samples taken and wanted (front only). */
  farFaces: number;
  farTarget: number;
  /** The outfit is done and the stage is waiting for faces: the dots pulse. */
  farWait: boolean;
  recording: boolean;
}

export function BodySilhouette({ side, progress, farFaces, farTarget, farWait, recording }: Props) {
  const fillY = H - Math.max(0, Math.min(1, progress)) * H;
  const done = progress >= 1;
  return (
    <div className={`body-fig ${side} ${recording ? 'rec' : ''} ${done ? 'done' : ''}`} data-testid="body-fig" data-progress={progress.toFixed(2)}>
      <svg viewBox="-10 -20 120 245" aria-hidden="true">
        <defs>
          <clipPath id="body-fill">
            <rect x="-10" y={fillY} width="120" height={H - fillY + 10} />
          </clipPath>
        </defs>
        <g className="fig">
          <circle className="fig-outline" cx="50" cy="22" r="15" />
          <path className="fig-outline" d={BODY} />
          <g clipPath="url(#body-fill)">
            <circle className="fig-fill" cx="50" cy="22" r="15" />
            <path className="fig-fill" d={BODY} />
          </g>
          {side === 'back' ? <path className="fig-mark" d="M 50 54 L 50 120" /> : <path className="fig-mark" d="M 44 26 Q 50 31 56 26" />}
          {!done && progress > 0 && <line className="fig-scan" x1="8" x2="92" y1={fillY} y2={fillY} />}
        </g>
        {side === 'front' && farTarget > 0 && (
          <g className={`far-dots ${farWait ? 'wait' : ''}`}>
            {Array.from({ length: farTarget }, (_, i) => {
              const a = Math.PI + (Math.PI * (i + 0.5)) / farTarget;
              return <circle key={i} className={i < farFaces ? 'on' : ''} cx={50 + Math.cos(a) * 26} cy={22 + Math.sin(a) * 26} r="4" />;
            })}
          </g>
        )}
        <text className="fig-label" x="50" y="-11" textAnchor="middle">
          {side === 'front' ? 'FRONT' : 'BACK'}
        </text>
      </svg>
    </div>
  );
}
