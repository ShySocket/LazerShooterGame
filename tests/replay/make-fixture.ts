/**
 * Writes tests/replay/fixtures/duel-close-4s.json: the first four seconds of the duel-close
 * simulation, seed 1, captured through the Recorder exactly as a phone round would be. Re-run when
 * the simulation world changes: node --import ./tests/register.mjs tests/replay/make-fixture.ts
 */
import { writeFileSync } from 'node:fs';
import { Recorder } from '../../src/debug/recorder';
import { SCENARIOS, simulate } from '../sim/engine';
import { buildScene } from '../sim/world';
import { Rng } from '../sim/rng';
import { FRAME_H, FRAME_W } from '../sim/world';

const scenario = SCENARIOS.find((s) => s.name === 'duel-close')!;
const scene = buildScene(new Rng(1), scenario.people, 'me');
const candidates = Object.entries(scene.profiles).map(([id, profile]) => ({ id, profile }));
const recorder = new Recorder({ width: FRAME_W, height: FRAME_H, candidates, selfId: 'me', hitThreshold: 0.5, hitMargin: 0.2, notes: 'duel-close seed 1, first 4 s of the simulation; alice is the target at 3 m, bob a bystander at 5 m' });
const result = await simulate(scenario, { seed: 1, durationMs: 4000, recorder });
const rec = recorder.recording();
writeFileSync(new URL('./fixtures/duel-close-4s.json', import.meta.url), JSON.stringify(rec));
console.log(JSON.stringify({ frames: rec.frames.length, fires: rec.fires.length, simCounts: result.counts }));
