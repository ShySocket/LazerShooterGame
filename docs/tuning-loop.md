# Calibration tuning loop

## Dry runs (2026-10-06)

Simulated rounds stand in for real feedback until phones have played: `npm run sim:feedback` records every shot of every scenario with the game's own shot recorder and labels it the way an honest reviewer would. Each export was run through `npm run tune`, and every proposal through the full `npm run tune:gate` in a scratch clone, at calibration 2026-10-01.11.

| export | shots / rounds | tune | gate |
|---|---|---|---|
| clean, seeds 1-5 | 3328 / 185 | proposes `faceAlpha` 0.45 → 0.5: 38 fewer misses (695 → 657), 0 replayed wrong hits, hold-out 183 → 170 misses | replay 0 wrong, typecheck, build, sim:full and sim:wide green; 2 unit tests that pin lock timing at 0.45 fail → exit 3, **draft PR "[tests need updating]"** |
| clean, seeds 1-2 | 1327 / 74 | no change: the best step saves 13 misses, the bar is 14 (1 % of shots) | not run |
| tiny (3 scenarios, 1 seed) | 132 / 11 | no change: fewer than 200 labelled shots | not run |
| 25 % of labels flipped | 1327 / 74 | no change: 9.5 % of labels contradict a confident game hit (ceiling 5 %) | not run |
| 2 % of labels flipped | 1327 / 74 | no change: 14 replayed wrong hits, the best one-step tightening removes only 2 (the rule needs half), so they go to a person | not run |
| 2 weakest right hits relabelled "should not count" | 1327 / 74 | tightens `faceAlpha` 0.45 → 0.40: both replayed wrong hits removed, 1 more miss | replay 0 wrong, sim:full green, **sim:wide finds a new wrong outcome (1 seed in 1000)** → exit 1, **no PR** |

What the runs taught:

- The replay is a model of the fusion, not of the tracker. A step it calls a tightening (a slower face belief) let a wrong outcome through in the full simulation. Only the gate's simulation sweeps catch that, so no proposal skips them.
- The sim exposed two defects that were fixed before the loop could run: shot ids repeated across scenarios, so relabelling one shot relabelled many; and at 2 % poisoned labels, below the contradiction ceiling, the search tightened the face-only bar to remove 2 of 14 replayed wrong hits for 13 misses, and would have kept tightening every night.
- Several unit tests pin behaviour at today's numbers. Any calibration move trips them, so a green-safety, red-unit-test gate opens a draft for a person rather than nothing. The loop's own tests were rewritten to hold at any calibration and were checked at 0.40, 0.45 and 0.5.
