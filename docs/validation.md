# Real-phone validation

The simulation (`npm run sim`) and the bench (`?bench`) cannot stand in for real phones: the bench re-views one photo, and the simulation's detector is a model of the real ones. This checklist is how a calibration earns the right to ship. It mirrors section 10 of `TRACKING_IMPROVEMENT_PLAN.md`.

## Recording a session

1. Enrol the players as for a normal round (different enrolment and evaluation captures: do not enrol from the same pose you then test).
2. Open the game with `?record` on the shooter's phone. Turn on **debug**, then **range**, and pick the person you are aiming at (or *Not a player*) so every tap carries its expected target.
3. Play the scenario. Tap **save rec** when done: the JSON holds boxes, landmarks, embeddings, histograms and taps, never pixels. It also holds every player's enrolled face signatures and outfit histograms, which are re-identifiable: tell the players, keep recordings with the same care as the room, and do not publish them.
4. Name the file `<scenario>__<phone>__<n>.json` (for example `stationary-3m__iphone12__1.json`) and put it under a folder such as `recordings/2026-09-20/`.
5. Note next to it: real distance, camera resolution, the face's size in pixels if known, device and browser, lighting.

## Scenarios

| Scenario | What to record | What to measure or enforce |
| --- | --- | --- |
| Stationary front view at 1.5, 3, 4.5, 6, 8 m | one file per distance, 20 taps each | body/face recall, first-lock time, correct hits / labelled shots |
| Moving front and back view | walk towards, away, across | lock on expected / frames, unclear, wrong (must be 0) |
| Crossings, reversals, foreground occlusion | two players crossing, one walking in front | wrong hits 0, no lock on the hidden player |
| Matching shirts, strangers, partial bodies | same top as a player; a non-player as the range target | wrong hits 0; unclear is the expected verdict |
| Camera pan and shake, walk-out before FIRE | pan while tapping; step the target out of the dot then tap | wrong hits 0 from obsolete geometry |
| Low light, backlight, blur, warm device | the same distances after 10 minutes of play | frame age (bench line), unclear rate |
| Freeze, pause and resume, rotate, camera switch | background the app mid-round, rotate, switch cameras | the lock expires (NO FRESH FRAMES), no stale hit after resume |

Include at least one older iPhone and one midrange Android, then the phones the players actually use.

## Running the set

```bash
node scripts/validate.mjs recordings/2026-09-20
```

The script replays every file through the current pipeline and prints, per recording and per scenario, correct and wrong hits over labelled shots, unclear and miss over all shots, and lock-on-expected over frames, with the denominators. It exits non-zero on any wrong hit. Zero wrong hits in a small sample is not proof of a zero rate; the denominators are the result.

To compare two calibrations on the same recordings, run the script on each branch (or with `npm run replay -- folder --threshold 0.6 --margin 0.25` for a quick threshold sweep) and put the two totals side by side.

## Choosing thresholds (plan 7.7 and 7.8)

- Select on held-out recordings that the thresholds were not tuned on, never on the enrolment captures.
- Order of decision: wrong hits first (must be zero), then wrong locks, then missed hits, then first-lock and hit latency.
- Change values only in `src/vision/calibration.ts` and bump `CALIBRATION_VERSION` in the same commit; every shot log entry, replay table and validation run prints that version, so results from different calibrations are never confused. Stored face scans stay raw normalised embeddings, so a recalibration never needs a rescan.
- Keep scores labelled as scores. Nothing in the pipeline is a calibrated probability.
- Record the run in `TRACKING_IMPROVEMENT_PLAN.md` next to the calibration version: recordings used, totals with denominators, what changed.
