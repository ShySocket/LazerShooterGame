# The phone session: what to record so the rubric turns green

Everything in `docs/tracking-rubric.md` that a machine can check is green (`npm run rubric`: every Must that needs no phone passes). What is left needs real phones in the real venue. One afternoon with two or three friends covers it. This page lists exactly what to do, which rubric ids each recording settles, and how to turn the results into a score.

## The short version (2026-10-01): one phone, 15 minutes, nothing to write down

Already checked without a phone (`npm run realcheck`, the e2e suite, 100 simulated seeds per scenario): the real models on photos of 28 real people and clips of 7, a real group-photo shooting check (0 wrong hits in 216 shots on 9 photos; the shots at one photo are not independent, so what that proves is that at most 28.3 % of such photos draw a wrong hit, 15.3 % per run, and the 1.38 % that 216 independent shots would give is not proven), whole rounds and practice sessions with a real clip as the camera. What only a phone can tell is how it behaves in your hands, in your light, at your distances.

1. On your phone open https://lazer-shooter-game.vercel.app/?practice (or tap **Practice alone**).
2. Do your scan, then **Add a target**: point the back camera at a friend, hips in view, and tap **Capture** (a TV or a photo works too, but only a person shows the outfit). Add a second target if someone else is around.
3. **Start game**. FIRE unlocks after the countdown. Choose **Aim at**, then tap the chips that describe the shot: **Target at** 1.5 / 3 / 5 / 8 m, **Seen from** front / side / back, **Light** normal / dim / backlit, **Doing** still / walking / crossing / occlusion / pan / look-alike / edge. A few shots per setting.
4. Tap **end round**. **Practice review** on the results screen shows every shot's frame with the crosshair, the verdict and what you set; tap **Wrong** first. The photos stay on the phone; only the numbers were uploaded.
5. On the Mac, once: `npx firebase-tools login`. Then `npm run session:report` prints the tables (or ask Claude to run it).

Note anything that felt wrong in words too (a hint that did not help, a verdict that surprised you): the log has the numbers, not the feel.

## The session matrix (GPT-6 Astra review, 2026-10-01)

The question this session answers: when good face evidence disappears, does the game still know who it is looking at, or does it carry a guess forward? The rule it is held to: when the evidence cannot tell the target apart, no hit.

**People and phones.** 4 to 6 people, at least one iPhone and one Android, and one person who is not playing (in clothes like a player's). Everyone joins one room on their own phone and does the **normal scan** (not practice capture). Start a round. The shooter taps **debug**, then **range**: shots now deal no damage, and each is logged with its answer and set-up exactly as in practice. Rotate who shoots and whose phone it is, so a phone and a target are never confused with each other.

**What to shoot.** About 10 taps per cell, choosing **Aim at** and the chips before each block. The labelled answer is who was under the dot at the tap; when you cannot tell, pick the other person rather than guessing, and say so in the notes.

| block | cells | chips |
| --- | --- | --- |
| Range | each player at 1.5, 3, 5 and 8 m, front, side and back | distance, view, light normal, still |
| Ambiguity | two players in similar tops side by side; the non-player in a matching top | look-alike (Aim at: the player, or *Not a player*) |
| Motion | two players crossing; one walking in front of the other; the target leaving the frame and coming back; a fast pan across two people | crossing, occlusion, walking, pan |
| Lighting | 3 m front: normal room light, half the lights off, against a bright window | light normal / dim / backlit |
| Association | two players overlapping; the dot on the edge of a body next to another | crossing, edge |
| Crowd | seven or more people in view (spectators count): the HUD should say "Too many people in view" | still |

The sample records each body's box, so face and torso size in pixels can be read back per shot alongside the distance.

**Reading it back.**

```bash
npm run session:report
```

Read the matrix from the `range` section (range mode in a real room, players who did the normal scan); `practice` is the `?practice` session with quick-enrolled targets, `review` the review-card answers, and `practice/range (unsplit)` holds shots from builds that did not record which of the two they were (do not judge the matrix on it). It prints, per condition, target, phone and build: right hits, hits on another player, hits on a non-player (counted apart), rejected legitimate shots, legit-shot success with the rejections in the denominator, resolve p50/p95, lock acquisition (p50/p95 from the target coming under the dot to the first lock on them, with the shots that never locked counted beside it as failures and those already under the dot when the recording began left out as untimed), and the one-sided 95 % Clopper-Pearson upper bound on the wrong-hit rate per target (round x target: the shots at one person share their light and outfit, so they are not independent), and per shot and per accepted hit as if they were. It exits 1 when any wrong hit is in the log. Look at every wrong hit's photo in **Practice review** on the shooter's phone before it is gone (the next round clears it).

**Development and evaluation.** Tune nothing on the session you judge with. The first session is the development set; after any threshold change, run a second session with at least one new person who enrols normally and the non-player, and report it held out:

```bash
npm run session:report -- --eval 2026-10-08
```

(the date of the held-out session; a round key or key prefix works too). Give the tuning tools the same argument, `npm run feedback:pull -- --eval 2026-10-08` and `npm run replay -- <export.json> --eval 2026-10-08`: they leave those rounds out of the triage and the calibration sweep and say how many they left out.

**Acceptance targets** (proposed by the review, not claims about today's build):

- zero observed wrong hits, wrong-player and unknown-person both; any wrong hit blocks a bigger round until its cause is found and fixed, and the one unexplained wrong hit from the 2026-09-26 real-photo runs stays open until a traced run explains it;
- at least 90 % legitimate-shot success in the conditions declared supported below;
- p95 lock acquisition under 500 ms, timed from the target coming under the dot, with the shots whose target was under the dot and never locked counted as failures beside it. A shot whose target was already under the dot when its recording began (the 12 frames before the tap) cannot be timed, so sweep onto the target and tap within a second for some taps of each cell rather than holding aim on it for seconds.

**Supported conditions** (fill from the held-out report; until then nothing is declared supported):

| condition | legit success | wrong hits / shots (95 % bound per target) | p95 lock (never locked) | supported? |
| --- | --- | --- | --- | --- |
| 1.5 m front | | | | |
| 3 m front | | | | |
| 3 m back | | | | |
| 5 m front | | | | |
| 8 m any | | | | |
| dim | | | | |
| backlit | | | | |
| crossing / overlap | | | | |

**The week-one decision.** If ordinary nearby play rejects most legitimate shots, the phone is missing information, and lowering thresholds cannot create it. The fixes are a distinct wearable identifier per player (a coloured bib or armband the outfit scan reads) or narrower supported conditions (for example, face-on within 5 m), not a looser hit rule.

**Sustained play.** A 20-minute round on the slowest iPhone and the slowest Android. Compare the first and last five minutes: frame period (the debug fps), lock acquisition and rejection rate (every shot sample carries its time into the round, `shot.roundMs`, and its frame period), battery lost, and whether the phone got hot enough to throttle.

**Multiplayer integrity.** During a round: toggle airplane mode for 10 s right after a hit (the HUD may say UNCONFIRMED; the target must lose at most one life, and never in the next round); two shooters fire at the same target within a second (one life lost); background and resume the app (the first FIRE afterwards must not land on an old frame).

## Scan check first (settles R8.01, R8.06, R8.13)

Since 2026-10-01 the scan cannot get stuck: the hint shows the angle the phone reads against the one it wants, after 6 s the best try counts and after 10 s **Skip this angle** appears, and it no longer refuses a turn as "a different face". If a prompt still needs Skip often, write down the readout it showed; that is what tunes the bands below.

Before anything else, enrol once on the iPhone and once on an Android. The face stage shows `yaw N° · pitch M°` under the hint. For each prompt, turn until the hint says "Hold it" and note:

- whether every prompt advanced within about 3 s of holding the pose (R8.01), and which one needed more than one try;
- the yaw the readout showed at a comfortable "slightly" turn and at a "further" turn, both sides, and the pitch at chin up and chin down (R8.13, these tune `SCAN_CALIB` in `src/vision/calibration.ts`);
- the time for the face scan and for the whole enrolment on the slowest phone (R8.06: under 45 s and under 2 min).

If a prompt refuses a correct pose, the numbers say why: the bands are straight 0 to 15°, slight 12 to 40°, further 25 to 60°, tilt 8 to 40°.

## New hints to watch for (2026-09-21 audit)

The app now names its corrections. On the phone, note whether these appear when they should and whether they help: "Move into better light and face the camera" (weak face detection), "Paused, someone else is in frame. Samples kept." (a bystander during the body scan), the small-room line under "Step back" after 5 s, "Loading models n of 4" with a Retry if the download stalls for 45 s, a Back button after 10 s on "Connecting", the advice line under UNCLEAR TARGET / CAMERA TOO SLOW / NO CAMERA LOCK, "Waiting for <name>'s phone to reconnect" in the lobby, and "Try again" after a failed scan save keeping the scan. From the 2026-09-22 pass: a red OFFLINE pill in the game and lobby while the phone has no link (walk out of Wi-Fi range for a moment), "NO CONNECTION, SHOT LOST" within 4 s for a hit fired while offline, "Waiting for <name> to reconnect (N s)" in the HUD when a survivor's phone drops, "Waiting for you to allow the camera…" under an open permission sheet, and "Loading models n of 4" on first open.

## Before the session

- Open https://lazer-shooter-game.vercel.app on every phone once on the venue Wi-Fi so the models are cached. Note each phone model and browser.
- Include the slowest phone you can find (an older iPhone or a midrange Android): it sets the honest range for the room.
- Read `docs/validation.md` once: it is the recording protocol this page points at.

## The recordings (settle R1.03, R5.01 to R5.03, R3.09, R3.10)

1. Enrol as for a normal round. Do not enrol from the pose you then test.
2. On the shooter's phone open the game with `?record` added to the URL, turn on **debug**, then **range**, pick who you are aiming at (or *Not a player*) and the distance. Every tap is then labelled and deals no damage.
3. Record these, 20 taps per cell, and save each with **save rec**:

| recording | what | rubric ids |
| --- | --- | --- |
| `stationary-<d>m__<phone>__<n>.json` at 1.5, 3, 4.5, 6, 8 m, face-on and then back view | the distance table | R5.01, R5.02, R1.03 |
| the same at 3 m and 6 m with half the lights off | dim light | R5.03 |
| `backlight-3m__<phone>__1.json`, the target in front of a window | UNCLEAR rather than a wrong name | R3.09 |
| `partial-back-1.5m__<phone>__1.json`, back view with the legs out of frame | shirt-only refusal | R3.10 |
| `crossing__<phone>__1.json`, `occlusion__<phone>__1.json`, `walkout__<phone>__1.json` | two players crossing; one walking in front; the target stepping out of the dot before FIRE | R1.03 (wrong must be 0) |
| `stranger__<phone>__1.json`, `same-shirt__<phone>__1.json`, `mirror__<phone>__1.json` | a non-player, a non-player in a matching top, a mirror | R1.03 |

Put the files under `recordings/<date>/`. A recording holds re-identifiable face and outfit signatures: tell the players, keep it with the same care as the room, never publish it.

4. Back at the computer:

```bash
node scripts/validate.mjs recordings/<date>
```

It prints correct and wrong hits per scenario with the denominators and exits non-zero on any wrong hit. Then

```bash
npm run rubric
```

reads the folder itself (R1.03 needs 200 labelled taps in total and zero wrong). Fill the distance table in `docs/tracking-rubric.md` section 5 from the per-scenario table and set R5.01 to R5.03, R3.09 and R3.10 in `docs/rubric-status.json` to `pass` or `fail` with the date and the numbers.

## The play-through (settles section 7 and the Should items)

One real round of 5 to 10 minutes with 3 or more players, then a second round. While playing, tick these in `docs/rubric-status.json` (status, date, one-line note):

- **R7.01** guest enrolment on one iOS Safari and one Android Chrome without a dead end.
- **R7.09** first open on venue Wi-Fi: models ready within 30 s with the status pill showing; reopen one phone in airplane mode to check the cache.
- **R7.03** mid-round: take a call, lock the screen, switch apps. Back in the same screen, camera restarted within 3 s, NO FRESH FRAMES until then, the first FIRE afterwards never lands.
- **R7.04** rotate the phone mid-round: no crash, no frozen crosshair, no hit from the old frame.
- **R7.06** airplane mode for 30 s mid-round: aiming and verdicts continue, hits queue or fail visibly, the room resyncs with no doubled hits.
- **R7.05** ten minutes on the warmest phone: no crash, frame period grows by less than 50 % (the bench line, or the debug FPS), screen stays on.
- **R7.10** sounds and haptics on hit, being hit, elimination, win.
- **R7.12** battery over a 20-minute round on a midrange phone.
- **R7.14** add to home screen on both platforms.
- **R4.06, R4.07, R4.09** from **Show my shot log** on the results screen: share of hits that were already green at the tap, UNCLEAR on clear face-on shots, median tap-to-verdict.
- **R3.11, R3.12** with debug on: live samples belong to the right player; overlay names agree with who is there.
- **R2.09, R6.12, R6.13** from `?bench` on the slowest phone: lock rate on a stationary target, period with 2 vs 12 profiles, six bodies in frame.

## Scoring

```bash
npm run rubric -- --note "phone session <date>"
```

The score line lands in `docs/rubric-scores.md`; the Must-only score is what "basic requirements" means for the demo. Anything still UNTESTED or FAIL is listed at the end of the output with its id and the evidence it wants.

## Go / no-go for the demo

Section 9 of `docs/tracking-rubric.md` is the demo-day protocol (venue, phones, a three-player smoke round, what to record). If any Must in section 1 fails on the recordings, run the demo in range mode (no damage) rather than with real scores.
