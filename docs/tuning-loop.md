# Calibration tuning loop

Every night a GitHub Actions job reads the labelled shot feedback players leave behind (the review card after each round, and every practice or range shot) and asks whether a small change to the calibration would land more legitimate shots without ever landing a wrong one. When the evidence says yes and every gate agrees, it opens a pull request. **It never merges.** A person reads the evidence and merges, and the next night continues from the merged numbers.

```
feedback/ in the database ──▶ npm run tune ──▶ proposal? ──no──▶ job summary, nothing else
                                     │ yes (calibration.ts written, version bumped)
                                     ▼
                              npm run tune:gate ──fail──▶ job summary, no PR
                                     │ green                  │ only pinned unit tests red,
                                     ▼                        ▼ safety checks green
                         PR tune/<date>-<run>         draft PR "[tests need updating]"
                         (previous tuning PR closed as superseded, CI dispatched on the branch)
```

## The pieces

| piece | what it does |
|---|---|
| `src/feedback/tune.ts` | The guarded search: one grid step per knob per run, greedy on the training rounds, checked on held-out rounds. Pure, no I/O. |
| `src/feedback/calibrationWrite.ts`, `scripts/calibration-write.ts` | Writes a proposal into `src/vision/calibration.ts` (each knob's constant must match exactly once), bumps `CALIBRATION_VERSION` (`<day>.<n>`), keeps README's face bars in sync. |
| `scripts/feedback-rest.ts` | Reads `/feedback` over REST with a service account (`FIREBASE_SA_KEY` or `GOOGLE_APPLICATION_CREDENTIALS`), so CI needs no `firebase-tools login`. |
| `npm run tune` (`scripts/tune.ts`) | Pull (or `--file`), triage, search, write. Leaves `pr-body.md`, `pr-title.txt`, `summary.json` and `samples.json` in `.rubric/tune/`. Exit 0 no change, 10 changed, 2 could not run. `--dry` decides without writing. |
| `npm run tune:gate` (`scripts/tune-gate.ts`) | Replays the tuned-on shots under the written calibration (zero wrong hits, hold-out too, version bumped), then `npm test`, typecheck, build, `sim:full`, `sim:wide`, and `realcheck` when `fixtures/real` is present. Every check runs; the table goes into the PR body. Exit 0 green, 3 only unit tests red, 1 otherwise. |
| `scripts/tune-nightly.sh` | One night: tune, gate, branch, PR. `DRY_RUN=1` prints the git/gh commands instead; `TUNE_FILE` tunes a saved export. |
| `.github/workflows/tune.yml` | Runs the script at 10:17 UTC and on demand (Actions > Nightly calibration tuning > Run workflow, with a dry-run box). |
| `npm run sim:feedback` (`tests/sim/feedback-export.ts`) | Simulated rounds recorded as labelled feedback (`--poison P` flips a share of labels), for testing all of the above without phones. |

Run a night locally against a saved export, pushing nothing:

```bash
DRY_RUN=1 TUNE_FILE=.rubric/feedback/sim-feedback.json scripts/tune-nightly.sh
```

That writes `src/vision/calibration.ts` when it proposes something; `git checkout src/vision/calibration.ts README.md` puts it back.

## What it may change

Only knobs the replay (`src/feedback/replay.ts`) re-runs faithfully from the recorded similarities: `FACE_CALIB` reject/accept, `FACE_ONLY_CALIB` reject/accept (tighten only: never lowered automatically), `EVIDENCE_WEIGHTS` face/cloth/body, `CLOTHING_EVIDENCE` floor/span, `STRANGER_BASELINE`, `FACE_BELIEF_ALPHA`, `CLOTHING_BELIEF_ALPHA`. Each moves at most one step a night (0.02 for bars, 0.05 for weights and rates) inside fixed bounds (`KNOBS` in `tune.ts`).

Never changed automatically, and why:

- **Hit threshold and margin**: room settings the host chooses.
- **Time windows and the tracker** (identity TTL, face freshness, track gaps, height gates, aim band, burst timing): the replay does not re-run the tracker, so it cannot judge them.
- **`FACE_MEAN` and the face model**: samples carry similarities, not embeddings, and the raw embeddings in round profiles are enrolment-biased and re-identifiable.

The PR body lists refused legitimate shots by the rule that refused them, so the causes the loop cannot touch are in front of whoever reads it.

## Guardrails (`TUNE_GUARDS`)

A wrong hit outweighs any number of misses, so most of these refuse:

- **Enough data** before any loosening: at least 200 labelled shots (v2 samples or newer) from at least 10 rounds.
- **Replay agrees with the game** on at least 90 % of shots. That is measured on the shots this calibration version played once there are 100 of them, otherwise on all shots.
- **Labels look honest**: no more than 5 % of labels contradict a hit the game took confidently (top belief ≥ 0.75, margin ≥ 0.35). Above that, nothing is proposed.
- **A proposal must hold up**:
  - zero replayed wrong hits on every round and on the held-out quarter of rounds;
  - the 95 % Clopper-Pearson upper bound on wrong hits, per hit and per round, does not rise;
  - it saves at least max(5, 1 % of shots) misses, and the held-out rounds gain at least one shot.
- **Tightening first**: when the current calibration replays a wrong hit, a tightening is proposed even below the data minimum, but only if:
  - it removes at least half of those wrong hits (mislabelled shots survive every step, and chasing them would ratchet the calibration nightly);
  - it costs at most 5 % of shots in new misses.
- **The gate decides, not the replay**. The replay models the fusion, not the tracker, and a replay "tightening" failed `sim:wide` in the dry runs below.

## One-time setup (Sai)

The workflow is inert until these are done. Without the secret it reports "nothing tuned" each night and exits green.

1. **A read-only service account for the database.** In a terminal with the Google Cloud CLI signed in as the project owner:

   ```bash
   gcloud iam service-accounts create feedback-reader --project lazer-shooter --display-name "Nightly tuning (read feedback)"
   gcloud projects add-iam-policy-binding lazer-shooter --member serviceAccount:feedback-reader@lazer-shooter.iam.gserviceaccount.com --role roles/firebasedatabase.viewer
   gcloud iam service-accounts keys create /tmp/feedback-reader.json --iam-account feedback-reader@lazer-shooter.iam.gserviceaccount.com
   ```

   Do not use the console's "Generate new private key" under Project settings > Service accounts: that key is the Admin SDK account and can write everything.

2. **Store it as the repository secret, then delete the file:**

   ```bash
   gh secret set FIREBASE_SA_KEY --repo ShySocket/LazerShooterGame < /tmp/feedback-reader.json && rm /tmp/feedback-reader.json
   ```

3. **Let Actions open pull requests:** GitHub > the repository > Settings > Actions > General > Workflow permissions > tick **Allow GitHub Actions to create and approve pull requests** > Save.

4. **Make sure phones can upload feedback:** the `feedback` rules in `database.rules.json` must be live. Firebase console > Realtime Database > Rules shows what is published; paste the file and Publish if `feedback` is missing.

5. **Optional, realcheck in CI:** Settings > Secrets and variables > Actions > Variables > New variable `TUNE_REALCHECK` = `1`. The job then fetches the public-domain photos once (`npm run fixtures`, cached) and runs `npm run realcheck` in the gate.

6. **Try it:** Actions > Nightly calibration tuning > Run workflow, with **dry run** ticked. The job summary shows the pull, the decision and the evidence. With little real data yet, expect "no change: fewer than 200 labelled shots".

Not verified until step 1 is done for real: that the database's REST API accepts a token from a service account holding only the Viewer role. Step 6's dry run is the check. If it fails with HTTP 401 or 403, the Viewer role is not enough for REST reads: grant `roles/firebasedatabase.admin` to `feedback-reader` instead (it can then write too, so the key must live only in the secret) and rerun step 6.

## Reviewing a tuning PR

- Read **Why** and the evidence table. The candidate's hold-out row must show 0 wrong.
- A **draft** means replay and both simulation sweeps passed but unit tests that pin today's numbers failed. Open the failing tests named in the gate table and decide for each: a pinned value to update (update it in the PR branch), or a real regression (close the PR).
- Run `npm run e2e` and, when you can, a short phone session before merging: CI cannot hold a phone.
- Merging bumps `CALIBRATION_VERSION`; shots recorded from then on are judged against the new numbers.

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
