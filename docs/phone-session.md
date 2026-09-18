# The phone session: what to record so the rubric turns green

Everything in `docs/tracking-rubric.md` that a machine can check is green (`npm run rubric`: every Must that needs no phone passes). What is left needs real phones in the real venue. One afternoon with two or three friends covers it. This page lists exactly what to do, which rubric ids each recording settles, and how to turn the results into a score.

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

Section 8 of `docs/tracking-rubric.md` is the demo-day protocol (venue, phones, a three-player smoke round, what to record). If any Must in section 1 fails on the recordings, run the demo in range mode (no damage) rather than with real scores.
