# The phone session: what to record so the rubric turns green

Everything in `docs/tracking-rubric.md` that a machine can check is green (`npm run rubric`: every Must that needs no phone passes). What is left needs real phones in the real venue. One afternoon with two or three friends covers it. This page lists exactly what to do, which rubric ids each recording settles, and how to turn the results into a score.

## The short version (2026-09-26): one phone, 15 minutes, nothing to write down

Already checked without a phone (`npm run realcheck`, `tests/e2e/realvision.spec.ts`, `tests/e2e/practice.spec.ts`): the real models on photos of 28 real people and clips of 7, a real group-photo shooting check (0 wrong hits), a whole round and a practice session with a real clip as the camera, and the new GhostNet face model and outfit veto. What only a phone can tell is how it behaves in your hands, in your light, at your distances. The easiest way to find out:

1. On your phone open https://lazer-shooter-game.vercel.app/?practice (or tap **Practice alone** on the home screen).
2. Do your scan, then **Add a target**: point the back camera at a friend (or a TV playing a video of a person, or a printed photo) and tap **Capture**. Add a second target if someone else is around.
3. **Start game**, choose **Aim at**, and work through **What to try** (face-on at 2, 4 and 6 m, their back, walking across, two targets crossing, *Not a player* on someone else, a mirror, dim light). A couple of shots each.
4. That's it. Every shot is logged with who you said you aimed at. Run `npx firebase-tools login` once on the Mac, and from then on `npm run feedback:pull` (or Claude) reads the log and lists every wrong hit and every miss by cause.

Note anything that felt wrong in words too (a hint that did not help, a verdict that surprised you): the log has the numbers, not the feel.

The full protocol below is for the venue day with several phones and the rubric.

## Scan check first (settles R8.01, R8.06, R8.13)

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
