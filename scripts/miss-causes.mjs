#!/usr/bin/env node
/**
 * Where the simulated misses come from. Wraps VisionPipeline.fire and classifies every instant
 * MISS by what the fire path saw: nobody detected under the dot, two boxes under it (a crossing),
 * another box within the aim edge band, the dot on a limb outside the observed torso/head, an
 * ambiguous face/body association, or a coasting track still covering the dot. Bursts that open
 * are counted separately.
 *
 *   node scripts/miss-causes.mjs pan-crossing crossing-backs [--seeds 30]
 *
 * Reads the pipeline's private fields, so it is a diagnostic, not a test. Measured 2026-09-17 over
 * 30 seeds: the crossing scenarios lose 15 to 20 points to misses, of which about a third are the
 * coasting-cover refusal, a third the dot on a limb, a quarter two overlapping boxes, and a
 * handful detector dropouts. All but the dropouts are deliberate refusals (see CLAUDE.md LESSONS).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
await import(pathToFileURL(fileURLToPath(new URL('../tests/register.mjs', import.meta.url))).href);
// Dynamic imports: the TypeScript hook above must be registered before the app's modules resolve.
const { simulate, SCENARIOS } = await import('../tests/sim/engine.ts');
const { VisionPipeline } = await import('../src/vision/pipeline.ts');
const { AIM_EDGE_BAND } = await import('../src/vision/calibration.ts');

const inside = (b, x, y) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
const nearBand = (b, x, y) => { const gx = b[2] * AIM_EDGE_BAND.x, gy = b[3] * AIM_EDGE_BAND.y; return x >= b[0] - gx && x <= b[0] + b[2] + gx && y >= b[1] - gy && y <= b[1] + b[3] + gy; };
const causes = {};
const bump = (k) => (causes[k] = (causes[k] ?? 0) + 1);
const orig = VisionPipeline.prototype.fire;
VisionPipeline.prototype.fire = function (context, crosshair, usable) {
  const L = this.latest;
  const r = orig.call(this, context, crosshair, usable);
  if (r.kind !== 'miss' || !L) { if (r.kind === 'pending') bump('_pending'); return r; }
  const cx = crosshair[0] + crosshair[2] / 2, cy = crosshair[1] + crosshair[3] / 2;
  const boxes = L.dets.map((d) => d.box);
  const under = boxes.map((b, i) => inside(b, cx, cy) ? i : -1).filter((i) => i >= 0);
  const near = boxes.filter((b) => !inside(b, cx, cy) && nearBand(b, cx, cy)).length;
  const coasting = L.coasting.filter((t) => inside(t.hit, cx, cy)).length;
  if (under.length === 0) bump(L.dets.length === 0 ? 'miss: no detections at all' : coasting ? 'miss: nobody detected under dot, coasting track there but blocked' : 'miss: nobody detected under dot (' + L.dets.length + ' dets)');
  else if (under.length > 1) bump('miss: two boxes under dot (overlap)');
  else if (near > 0) bump('miss: one box under dot, another within edge band');
  else if (!inside(L.tracks[under[0]].hit, cx, cy)) bump('miss: inside box but outside observed torso/head');
  else if (L.dets[under[0]].associationAmbiguous) bump('miss: face/body association ambiguous');
  else bump('miss: other (coasting cover?)');
  return r;
};
const args = process.argv.slice(2);
const seedArg = args.indexOf('--seeds');
const seeds = seedArg >= 0 ? Number(args[seedArg + 1]) : 30;
const names = args.filter((a, i) => a !== '--seeds' && i !== seedArg + 1);
for (const name of names.length ? names : ['pan-crossing', 'crossing-backs', 'crossing']) {
  for (const k of Object.keys(causes)) delete causes[k];
  let miss = 0, possible = 0, shots = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const r = await simulate(SCENARIOS.find((s) => s.name === name), { seed });
    miss += r.counts.miss; possible += r.possibleShots; shots += r.shots.length;
  }
  console.log(`\n${name}: ${shots} shots, ${possible} possible, ${miss} miss`);
  for (const [k, v] of Object.entries(causes).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
}
process.exit(0);
