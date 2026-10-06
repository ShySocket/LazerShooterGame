import { SCAN_CALIB, type FaceStage, type FaceStep } from '../vision/scan';
import { arrowFor, dotPosition, zoneStates, type Arrow, type Pt, type ZoneKey, type ZoneState } from '../vision/scanRing';

/**
 * The face-scan ring over the selfie preview: zones laid out where the head goes, a dot that follows
 * the live head angle, and an arrow to the zone when a frame did not count. All decisions come from
 * scan.ts and scanRing.ts; this only draws them. Drawn in screen space, outside the mirrored video.
 */

/** Ticks every 4°; side zones cover ±26° around 180° (a) and 0° (b), chin up/down ±30° around the top and bottom. */
const TICK_STEP = 4;
const SIDE_SPAN = 26;
const TILT_SPAN = 30;

const angDist = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

interface Tick {
  a: number;
  zone: ZoneKey | null;
  outer: boolean;
}

function ticksFor(keys: ZoneKey[]): Tick[] {
  const out: Tick[] = [];
  for (let a = 0; a < 360; a += TICK_STEP) {
    const side = angDist(a, 0) <= SIDE_SPAN ? 'b' : angDist(a, 180) <= SIDE_SPAN ? 'a' : null;
    const tilt = angDist(a, 270) <= TILT_SPAN ? 'up' : angDist(a, 90) <= TILT_SPAN ? 'down' : null;
    if (side) {
      const slight = `slight-${side}` as ZoneKey;
      const further = `further-${side}` as ZoneKey;
      out.push({ a, zone: keys.includes(slight) ? slight : null, outer: false });
      if (keys.includes(further)) out.push({ a, zone: further, outer: true });
    } else out.push({ a, zone: tilt && keys.includes(tilt) ? tilt : null, outer: false });
  }
  return out;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const at = (deg: number, r: number): Pt => [Math.cos(rad(deg)) * r, Math.sin(rad(deg)) * r];
const f = (n: number) => n.toFixed(3);

function ArrowMark({ arrow }: { arrow: Arrow }) {
  if (arrow.kind === 'none') return null;
  if (arrow.kind === 'further') {
    // The face should get smaller: chevrons on the ring pointing in.
    return (
      <g className="ring-arrow further">
        {[45, 135, 225, 315].map((a) => {
          const [x, y] = at(a, 0.92);
          return <path key={a} d="M -0.09 -0.07 L 0 0.02 L 0.09 -0.07" transform={`translate(${f(x)} ${f(y)}) rotate(${a + 90})`} />;
        })}
      </g>
    );
  }
  const [fx, fy] = arrow.from;
  const ends: Pt[] =
    arrow.kind === 'either-x' ? [[Math.abs(arrow.to[0]), fy], [-Math.abs(arrow.to[0]), fy]] : arrow.kind === 'either-y' ? [[fx, Math.abs(arrow.to[1])], [fx, -Math.abs(arrow.to[1])]] : [arrow.to];
  return (
    <g className={`ring-arrow ${arrow.kind}`}>
      {ends.map(([tx, ty], i) => {
        const dx = tx - fx;
        const dy = ty - fy;
        const len = Math.hypot(dx, dy);
        if (len < 0.12) return null;
        const ux = dx / len;
        const uy = dy / len;
        // Start clear of the dot and stop short of the target, so the head sits on the zone.
        const sx = fx + ux * 0.1;
        const sy = fy + uy * 0.1;
        const ex = tx - ux * 0.04;
        const ey = ty - uy * 0.04;
        const ang = (Math.atan2(uy, ux) * 180) / Math.PI;
        return (
          <g key={i}>
            <line x1={f(sx)} y1={f(sy)} x2={f(ex)} y2={f(ey)} />
            <path d="M -0.09 -0.07 L 0 0 L -0.09 0.07" transform={`translate(${f(ex)} ${f(ey)}) rotate(${f(ang)})`} />
          </g>
        );
      })}
    </g>
  );
}

interface Props {
  stage: FaceStage;
  reason: FaceStep['reason'];
  /** Live head angle of the last measured frame, null with no face. */
  angles: { yaw: number; pitch: number } | null;
  /** Lap just completed: plays the sweep while true. */
  flourish: boolean;
}

export function ScanRing({ stage, reason, angles, flourish }: Props) {
  const zones = zoneStates(stage);
  const state = new Map<ZoneKey, ZoneState>(zones.map((z) => [z.key, z.state]));
  const ticks = ticksFor(zones.map((z) => z.key));
  const dot = angles ? dotPosition(angles.yaw, angles.pitch, stage.scan) : null;
  const arrow = arrowFor(stage, reason, dot);
  const charged = stage.scan.hold / SCAN_CALIB.holdFrames;
  const centre = state.get('centre');
  const expression = state.get('expression');
  const locked = zones.filter((z) => z.state === 'locked').length;
  const cls = ['scan-ring', `lap-${stage.lap}`, reason === 'blocked' ? 'blocked' : '', flourish ? 'flourish' : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} data-testid="scan-ring" data-locked={locked} data-zones={zones.length}>
      <svg viewBox="-1.35 -1.35 2.7 2.7" aria-hidden="true">
        <defs>
          <mask id="ring-hole">
            <rect x="-5" y="-5" width="10" height="10" fill="#fff" />
            <circle r="0.98" fill="#000" />
          </mask>
        </defs>
        <rect className="ring-dim" x="-5" y="-5" width="10" height="10" mask="url(#ring-hole)" />
        {ticks.map((t, i) => {
          const [r0, r1] = t.outer ? [1.13, 1.27] : [1.0, 1.1];
          const [x0, y0] = at(t.a, r0);
          const [x1, y1] = at(t.a, r1);
          const st = t.zone ? state.get(t.zone) : undefined;
          const k = ['tick', t.zone ? `zone-${st}` : 'deco', st === 'target' && charged > 0 ? 'charged' : ''].filter(Boolean).join(' ');
          return <line key={i} className={k} x1={f(x0)} y1={f(y0)} x2={f(x1)} y2={f(y1)} style={{ animationDelay: `${(i % 12) * 18}ms` }} />;
        })}
        {expression && <circle className={`centre-ring zone-${expression}`} r="0.22" />}
        {centre && <circle className={`centre-disc zone-${centre}`} r="0.1" />}
        <ArrowMark arrow={arrow} />
        {dot && <circle className={`ring-dot ${reason === 'ok' ? 'on' : ''}`} r="0.075" style={{ transform: `translate(${f(dot[0])}px, ${f(dot[1])}px)` }} />}
        {flourish && (
          <g className="sweep">
            <line x1="0" y1="0" x2="1.3" y2="0" />
            <path className="check" d="M -0.2 0 L -0.06 0.14 L 0.22 -0.16" />
          </g>
        )}
        <text className="lap-label" x="0" y="-1.3" textAnchor="middle">
          LAP {stage.lap}/2
        </text>
      </svg>
    </div>
  );
}
