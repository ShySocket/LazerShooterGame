# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lazer Shooter: real-life laser tag played with phones as a mobile web app (Vite + React + TypeScript PWA). Players enroll face and outfit, then hunt each other with the rear camera. All vision runs on-device with `@vladmandic/human` (BlazeFace + FaceMesh + InsightFace embeddings + MoveNet MultiPose); Firebase Realtime Database syncs rooms, lives, and hits. Only numeric signatures are shared, never photos. README.md is the authoritative description of how a hit is decided and of the thresholds; keep it in sync when tuning constants.

## Verification commands

Run all of these before declaring any tracking or decision change done:

```bash
npm test                       # tsc (tests config) + node --test tests/*.test.ts, incl. a 3-seed sim round
npm run typecheck              # tsc for app and tests
npm run sim -- --seeds 100     # 100-seed simulation table for every scenario
npm run build                  # tsc + vite build
npm run rubric                 # score against docs/tracking-rubric.md (sim + tests + build + recorded evidence), logs to docs/rubric-scores.md
npm run e2e                    # Playwright: 16 multiplayer/robustness scenarios on the installed Chrome against live Firebase (~80 s), writes .rubric/e2e.json
```

Other useful commands:

```bash
npm run sim                                    # 3-seed table, prints per-scenario hit/wrong/lock stats
npm run sim -- occlusion --seeds 100           # filter scenarios by name substring
npm run sim:full                               # 100 seeds, --strict: exit 1 on any wrong hit / wrong lock, prints traces
node --import ./tests/register.mjs --test tests/tracker.test.ts   # one test file
node --import ./tests/register.mjs --test --test-name-pattern "crossing" tests/sim.test.ts   # one test by name
npm run dev                                    # HTTPS dev server on the LAN (camera needs HTTPS)
npm run dev:http                               # plain HTTP, for browser QA without camera
npm run replay:rec [folder]                    # replay ?record recordings through the current calibration
npm run replay -- feedback.json                # re-score the uploaded shot-feedback labels (src/feedback/replay.ts)
```

Node 22.15+ is required. Tests run the app's TypeScript directly through `tests/register.mjs` (a `node:module` hook that transpiles with `typescript`), so there is no test bundler or jest config. `.claude/launch.json` defines `dev` (5173, https) and `dev-http` for the browser preview.

To reproduce one simulated seed in isolation (the plan doc uses this):

```bash
node --import ./tests/register.mjs --input-type=module <<'JS'
import { simulate, SCENARIOS } from './tests/sim/engine.ts';
const r = await simulate(SCENARIOS.find(s => s.name === 'occlusion'), { seed: 60 });
console.log(r.counts, r.wrongLockFrames, r.shots.filter(s => s.outcome === 'wrong'), r.wrongTraces);
JS
```

## Architecture

**Screens and state** (`src/App.tsx`, `src/screens/`): Home → Enroll → Lobby → Game → Results, driven by a `Room` record subscribed from the backend. `src/net/index.ts` picks `FirebaseBackend` when a Firebase config is present, else `LocalBackend` (`VITE_LOCAL_MODE=1`, one phone, no network, `MIN_PLAYERS` = 1). Both implement `RoomBackend` in `src/net/backend.ts`. Rooms live at `rooms/{CODE}` (4 uppercase letters, open read/write per `database.rules.json`); signed-in accounts store a one-time deep scan at `users/{uid}` (owner-only). The Firebase web config in `src/net/firebaseApp.ts` is public client config by design.

**Vision loop** (`src/hooks/useVisionLoop.ts`, `src/vision/human.ts`, `src/vision/serial.ts`): one shared `Human` instance, accessed only inside `withHumanSession` so a full-frame pass and its follow-up face crops are serialized. `configurePass` flips Human's mutable config between the `frame` pass (bodies + face boxes only) and the `crop` pass (mesh + InsightFace on magnified square crops). Camera pixels are copied to a canvas per frame and are immutable for the duration of a session; `VisionFrame.isCurrent()` must be re-checked after every await.

**Identity pipeline** (`src/vision/pipeline.ts`, `VisionPipeline`): the single entry point between detector output and a shot verdict, used unchanged by the game screen, the phone bench, and the simulation. Per frame it: builds `Detection`s (`tracker.ts: buildDetections`, which assigns faces to bodies and computes the hittable `hit` region from observed torso/head landmarks), matches them to `Track`s (`Tracker`), samples outfit histograms (`clothing.ts`) and body ratios, runs face embeddings on selected crops, and fuses evidence into per-track `belief` (`scoring.ts: faceEvidence / clothingEvidence / combineEvidence`). Candidates always include two decoys: the shooter's own profile and `UNKNOWN_ID` (stranger baseline). `fire()` picks the track whose hit region contains the crosshair and either resolves instantly (geometry younger than `GEOMETRY_FRESH_MS`, belief above `hitThreshold` and ahead by `hitMargin`) or opens a pending burst that must re-see the same track under the dot in a frame captured after the tap (`shot.ts`).

**Calibration** (`src/vision/calibration.ts`): every tunable (face thresholds, evidence weights, track gaps, height gates, aim band, shot timing, live-enrolment gates) with a `CALIBRATION_VERSION` that the shot log records. The owning modules re-export the same names, so import from them as before; bump the version when a value changes.

**Face similarity** is cosine of mean-centred embeddings (`embedding.ts: centredSimilarity`, mean vector in `faceMean.ts`). `FACE_CALIB` thresholds were measured against that centring; do not compare raw cosine values to them. `centredSimilarity` caches per array identity, so never mutate an embedding array in place.

**Simulation** (`tests/sim/`): `world.ts` is a synthetic 3D scene and detector model (dropouts, jitter, similarity levels tuned to the real models); `engine.ts` plays whole rounds through the real `VisionPipeline`, judges each shot against ground truth (`visible` person under the dot, `ambiguous` near a nearer person's edge), and records `wrongTraces`; `report.ts` prints the table and is the `--strict` gate. `tests/sim.test.ts` holds acceptance thresholds and pins seeds that once produced a wrong hit or wrong lock. Wrong hits and wrong-lock frames are the outcomes the game must never produce; hit rates are bounded loosely.

**Device bench** (`src/bench/`, open the app with `?bench`): runs a photo through the real models and pipeline with a virtual drifting camera, and a range sweep across zoom levels. Use it to see a real phone's frame period and where face gives out to outfit.

**Deploy**: Vercel builds every push to `main` and serves https://lazer-shooter-game.vercel.app (the shareable link). `.github/workflows/ci.yml` is the merge gate on pull requests (tests, typecheck, build, `sim:full`); `npm run e2e` (Chrome + live Firebase) runs on a developer machine before a PR. Never push to `main` directly from an agent session; open a PR and merge it when CI is green.

## Current work

`TRACKING_IMPROVEMENT_PLAN.md` holds the 2026-09-13 review, the 2026-09-14 investigation and implementation record (all twelve items landed), and the 2026-09-17 measurement of where the crossing misses go (`scripts/miss-causes.mjs`: the cover, torso and overlap refusals, by design). `docs/tracking-rubric.md` is the checklist of what a demo-ready round must pass; `npm run rubric` scores it (v1 on 2026-09-17: 69.8/100, Must 37/46, every Must that needs no phone green). The demo-ready work of 2026-09-17 (PR #4) added the scorer, atomic round end and host migration, transactional join/start/hits that survive a phone with no local cache, camera restart on resume, SHOT LOST, model-load retry, `tests/net.test.ts` with an in-memory database, and the Playwright suite (`npm run e2e`, 16 scenarios, eight simulated phones, `?e2e` dev-only hook in `src/e2e/hook.ts`). What remains needs phones: `docs/phone-session.md` says what to record, `docs/rubric-status.json` holds the phone evidence the scorer reads, and `docs/validation.md` is the recording protocol.

## LESSONS

- Raising hit confidence or extending tracking timeouts alone is not a fix; find the identity/aim root cause.
- A tap must keep its tap-time rule: a burst may be nominated only from the observed torso (moved by the track's motion), never from the outer box. Outer-box nomination bought nine points in the pan crossing and one hit on a player nobody was aiming at when the tap happened (approach seed 95, 2026-09-14). Hit-rate gains that come from loosening what counts as "under the dot" are not gains.
