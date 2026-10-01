# Tracking and demo-readiness rubric

What "good enough" means for the demo: a free-for-all round with many players (target: 8 to 12 phones in one room), where every phone tracks the people it sees, decides shots correctly, and nobody hits a bug. Tracking here means both halves: following a person across frames, and deciding whether a FIRE press on them is a hit.

How to use this file:

- Every line is a checkbox. Tick it only with the evidence named next to it (a sim table, a `validate.mjs` run, or a real round with the shot log).
- **Must** items gate the demo. One failing Must means the demo is not ready, whatever the rest says.
- **Should** items are what makes the game feel good. Aim to pass all of them, but a miss is a known limitation to tell players about, not a blocker.
- **Nice** items are polish. Skip them until every Must and Should is green.
- Numbers come from three sources: what the automated gates already enforce (`tests/sim.test.ts`, `npm run sim:full`), what `docs/validation.md` says to measure on phones, and the targets proposed here for a real venue. Where a real-phone target is lower than the sim bound, that is deliberate: the sim's detector is a model of the real one.
- Every scored line ends in a comment `<!-- Rn.nn evidence -->`: a stable id and the evidence that earns the tick. `auto:sim.x` is a check on the simulation aggregates, `auto:test:<name>` a named unit test that must pass, `auto:build` the production build, `auto:validate` the real-phone validation set, `e2e:<name>` a Playwright test, `phone` a real-phone measurement recorded in `docs/rubric-status.json`, `manual` a hand-checked item recorded in the same file. `npm run rubric` reads these and prints the score; sections 9 to 11 are procedure, not scored.
- Order of decision when two items conflict: wrong hits first (must be zero), then wrong locks, then missed hits, then latency. Never buy a hit rate by loosening what counts as "under the dot" (see the LESSONS in `CLAUDE.md`).

Tiers of outcome, so you know what to aim for overall:

| Tier | Meaning |
| --- | --- |
| **Demo-ready** | All Must items green on the sim gate and on at least one real recorded session with the phones people will actually use. |
| **Good** | Demo-ready plus all Should items in section 2 to 5 (tracking, identity, shots). Players rarely see UNCLEAR TARGET when the aim was clearly on someone. |
| **Great** | Good plus the Should items in sections 6 and 7 and most Nice items. A stranger can watch a round and not tell it apart from real laser tag. |

---

## 1. Safety of the decision (never wrong)

These are the outcomes the game must never produce. They are the reason UNCLEAR TARGET exists.

Automated evidence: `npm run sim:full` (100 seeds, `--strict`, exit 1 on any wrong hit or wrong-lock frame) and `npm test`.
Real-phone evidence: `node scripts/validate.mjs recordings/<date>` exits 0, with denominators printed.

- [ ] **Must**: Zero wrong hits across all sim scenarios over 100 seeds (`npm run sim:full` passes). <!-- R1.01 auto:sim.wrong0 -->
- [ ] **Must**: Zero wrong-lock frames in crossing, pan-crossing, crossing-backs, occlusion, identical-tops, stranger, mirror, same-shirt-stranger, lookalike-faces (sim, 100 seeds). <!-- R1.02 auto:sim.wrongLock0 -->
- [ ] **Must**: Zero wrong hits over every labelled real-phone recording (`validate.mjs` exit 0). Record the denominator: at least 200 labelled taps in total across scenarios before calling this passed. <!-- R1.03 auto:validate -->
- [ ] **Must**: A stranger (non-player) in frame is never hit and never wears a player's name, even hedged (`maybeOnNonPlayer` = 0 in sim; in a real round, the HUD says NOT A PLAYER or STRANGER, never a name, for at least 60 s of aiming at a non-player at 2 to 6 m). <!-- R1.04 auto:sim.stranger -->
- [ ] **Must**: A stranger wearing the same top as a player is never hit (sim `same-shirt-stranger`; real: borrow a matching top and do 20 range-test taps, all must be NOT A PLAYER or UNCLEAR TARGET). <!-- R1.05 auto:sim.sameShirt -->
- [ ] **Must**: Aiming at a mirror or at yourself resolves to THAT IS YOU, never to another player (sim `mirror`; real: 20 taps at a mirror at 1.5 to 3 m). <!-- R1.06 auto:sim.mirror -->
- [ ] **Must**: Two players with identical tops, seen from behind, get UNCLEAR TARGET rather than a guess (sim `identical-tops` wrong = 0 and wrongLockFrames = 0; the lobby refuses to start when two outfits are too alike, so in a real round this only happens when a player changes clothes after enrolling). <!-- R1.07 auto:sim.identicalTops -->
- [ ] **Must**: A player walking in front of the target does not become the target (sim `occlusion` wrong = 0; regression seeds 39 and 60 stay green). <!-- R1.08 auto:sim.occlusion -->
- [ ] **Must**: No hit from obsolete geometry: a target who steps out of the dot before FIRE is not hit (real: 20 "walk-out before FIRE" taps, all MISS or UNCLEAR TARGET; sim: instant hits only from geometry under `GEOMETRY_FRESH_MS` = 250 ms). <!-- R1.09 auto:test:pre-tap or late frame -->
- [ ] **Must**: After the app is backgrounded, rotated, or the camera is switched mid-round, the first FIRE afterwards never lands on a stale frame (HUD shows NO FRESH FRAMES or CAMERA TOO SLOW until new frames arrive). <!-- R1.10 e2e:background-resume -->
- [ ] **Should**: Ambiguous verdicts (dot within the jitter band of a nearer person's edge) stay at zero where people stand apart and under the per-scenario ceilings in `tests/sim.test.ts` (occlusion 20 %, range-8m 12 %, crossings 8 %). A rising count is where a wrong hit would hide. <!-- R1.11 auto:sim.ambiguous -->
- [ ] **Should**: The eliminated-player race is closed: a shot fired just before the last elimination cannot land after the round is decided (`evaluateHit` refuses hits once at most one enrolled player is alive; verify by having two players fire at each other within the same second at 1 life each; exactly one is eliminated). <!-- R1.12 auto:test:last elimination -->
- [ ] **Must**: On real photos of real people (standing groups, `npm run realcheck -- shoot`, 18 runs of 12 shots), the real models and pipeline never hit or lock the wrong person. <!-- R1.13 auto:realcheck -->
- [ ] **Must**: A non-player whose face reads as much like a player as real different faces do (0.66) but who wears other clothes is never hit and never wears the player's name (sim `lookalike-stranger`, outfit veto). <!-- R1.14 auto:test:whose face reads like a player -->
- [ ] **Must**: An identity is re-earned after every uncertain transition (crossing, reclaim after a gap, a height or centre jump, an ambiguous face, a face read that names somebody else): two fresh face samples or two clothing samples on that body before it may lock or hit again, and a burst never lands on a track that went through one after the tap (sim `crossing-lookalike-faces`, `vetoed-player`, `lookalike-stranger-slow`: 0 wrong, 0 wrong-lock frames over 100 seeds). <!-- R1.15 auto:test:identity does not ride across a crossing -->
- [ ] **Must**: A face names a player at the normal bar only while that player's own outfit backs it on this body (a matching clothing sample within 3 s, not during an overlap); otherwise, and for a candidate with no outfit on file, the face must clear `FACE_ONLY_CALIB`. A look-alike stranger whose torso cannot be read is never named. <!-- R1.16 auto:test:a look-alike stranger whose torso cannot be read -->
- [ ] **Must**: A frame at the pose model's body cap (`BODY_CAP` = 6) may be missing somebody, so a hit then needs this body's latest face read, from a frame within 400 ms (`OVERLAP_FACE_FRESH_MS`) of this body's latest frame, to name the same player by the full margin, as during an overlap, and the HUD says "Too many people in view" (sim `crowd-seven` and `crowd-seven-slow`, 400 ms per frame: 0 wrong, 0 wrong-lock frames). <!-- R1.17 auto:test:a crowd past the detector body cap -->
- [ ] **Must**: The real-phone session (`docs/phone-session.md`, the matrix) shows zero wrong hits, wrong-player and unknown-person counted apart, with the Clopper-Pearson bound printed by `npm run session:report`; at least 90 % legitimate-shot success (rejections in the denominator) in the conditions declared supported; p95 lock acquisition under 500 ms. Any wrong hit blocks a bigger round until its cause is understood. <!-- R1.18 phone -->

## 2. Following a person (track continuity)

A track is the pipeline's memory of one body. Losing it costs the lock; swapping it is a wrong hit in waiting.

Automated evidence: `npm run sim -- --seeds 100`, columns `tracks` (track ids the target went through; 1 is perfect), `firstLockMs`, `lock`.
Real-phone evidence: bench (`?bench`) `tracks` and `lock on target`; recordings replayed with `npm run replay:rec`.

- [ ] **Must**: A stationary player at 1.5 to 4.5 m keeps one track id for a full 60 s of aiming (bench `tracks` = 1; sim `duel-close` trackChurn <= 2). <!-- R2.01 auto:sim.duelChurn -->
- [ ] **Must**: A player who turns their back and faces the shooter again keeps the same identity throughout (sim `turn-around` trackChurn <= 2, hit rate >= 85 %). <!-- R2.02 auto:sim.turnAround -->
- [ ] **Must**: A pose model that drops a quarter of its frames does not lose the target (sim `flaky-pose` trackChurn <= 4, hit rate >= 80 %). <!-- R2.03 auto:sim.flakyPose -->
- [ ] **Must**: Two players crossing each other, facing the camera or facing away, never swap identities (sim `crossing`, `crossing-backs`: wrongLockFrames = 0). While they overlap (IoU above `CROSSING_IOU` = 0.25) the HUD shows LOCKING or UNCLEAR TARGET, not a green name. <!-- R2.04 auto:sim.crossings -->
- [ ] **Should**: First lock on a face-on player at 3 m within 1.5 s of them entering the frame (sim `duel-close` firstLockMs < 1500; real: time from "steps into view" to green name, 10 trials, median under 1.5 s, worst under 3 s). <!-- R2.05 auto:sim.firstLock -->
- [ ] **Should**: A crossing during a camera pan keeps the target on the same track more than half the time (sim `pan-crossing` hit rate >= 35 % is the gate; 55 % was the measured value on 2026-09-14; aim to keep or raise that, never trade it for a wrong lock). <!-- R2.06 auto:sim.panCrossing -->
- [ ] **Should**: A track skipped by the detector for under 450 ms (`TRACK_GAP_MS`) continues without a new id; one lost for up to 1.5 s (`LOST_TRACK_MS`) is reclaimed unconfirmed and needs fresh evidence before it can lock again. Verify in a real round by having the target step behind a pillar for one second: the name returns within 2 s of them reappearing and no hit lands while they are hidden. <!-- R2.07 auto:test:reappearance after a long gap -->
- [ ] **Should**: A body that reappears at a very different height (someone else stepping into the old box) does not inherit the identity (`HEIGHT_MATCH_MIN` 0.6 / `HEIGHT_CONFIRM_MIN` 0.75). Real check: player A ducks out, player B of a different height steps in; B never shows A's name. <!-- R2.08 auto:test:(a, tracker level) -->
- [ ] **Nice**: Lock rate on a stationary target in the bench above 90 % of frames while the person is under the dot, at 3 m in good light on the slowest phone in the group. <!-- R2.09 phone -->

## 3. Knowing who it is (identity)

Face carries the identity up close and face-on; outfit carries it at range and from behind; body ratios only break ties.

- [ ] **Must**: Face-on at 1.5 to 3 m in normal indoor light, the right name locks (sim `duel-close` hit rate >= 90 %; real: range test, 20 taps per distance, correct >= 85 %). <!-- R3.01 auto:sim.duelHit -->
- [ ] **Must**: From behind, the outfit carries the hit without guessing between players (sim `back-shot` hit rate >= 75 %, wrong = 0; real: 20 back-view taps at 3 m, correct >= 65 %, wrong = 0). <!-- R3.02 auto:sim.backShot -->
- [ ] **Must**: At 8 m the outfit still carries most shots (sim `range-8m` hit rate >= 60 %; real: 20 taps at 8 m, correct >= 45 %, wrong = 0, everything else UNCLEAR TARGET, not a wrong name). <!-- R3.03 auto:sim.range8m -->
- [ ] **Must**: The lobby refuses to start when two players' outfits or face scans are too alike, and names the pair, so an identity clash is fixed by changing a top before the round, not by a wrong hit during it. <!-- R3.04 e2e:lobby-gating -->
- [ ] **Must**: Same-hue tops of a different shade are still told apart from behind (sim `lookalike-tops` wrong = 0, hit rate >= 50 %). <!-- R3.05 auto:sim.lookalikeTops -->
- [ ] **Must**: Two players whose faces read alike to the model are never confused (sim `lookalike-faces` wrong = 0, wrongLockFrames = 0). In a real group, if the lobby warns two faces conflict, the round must still be safe because hits between them lean on outfits: verify with 20 taps each way, wrong = 0. <!-- R3.06 auto:sim.lookalikeFaces -->
- [ ] **Should**: An approaching target locks before they are close (sim `approach` hit rate >= 85 %; real: walking in from 8 m, the name appears by 5 m). <!-- R3.07 auto:sim.approach -->
- [ ] **Should**: Dim light lowers confidence, not correctness (sim `dim-light` hit rate >= 80 %, wrong = 0; real: the same 3 m range test with half the venue lights off, wrong = 0 and correct >= 60 %). <!-- R3.08 auto:sim.dimLight -->
- [ ] **Should**: Backlight (a window behind the target) yields UNCLEAR TARGET rather than a wrong name (real: 20 taps, wrong = 0). <!-- R3.09 phone -->
- [ ] **Should**: A partial body (legs cut off at close range from behind) gives UNCLEAR TARGET rather than a shirt-only guess (`CLOTHING_EVIDENCE.noThighsCap` = 0.55 keeps a shirt alone below a hit). Real: 10 close back-view taps with legs out of frame, wrong = 0. <!-- R3.10 phone -->
- [ ] **Should**: Live face enrolment during a round only adds strong, unambiguous samples (`LIVE_FACE_MIN` 0.9, runner-up under 0.3). Real check: after 5 minutes of play, the shot log shows no live sample attached to the wrong player (compare `via` and the top-two similarities). <!-- R3.11 phone -->
- [ ] **Nice**: The debug overlay names and confidence on every visible body agree with who is actually there for 30 s of panning across the whole group. <!-- R3.12 phone -->

## 4. Deciding the shot (FIRE to verdict)

- [ ] **Must**: An instant hit only decides from geometry under 250 ms old; older frames open a burst that must re-see the same person under the dot in a frame captured after the tap (`shot.ts`; pinned by `tests/pipeline.test.ts`). <!-- R4.01 auto:test:(j) a nomination from motion -->
- [ ] **Must**: A phone that needs 400 ms per frame still fires and hits rather than refusing everything as stale (sim `slow-phone` stale = 0, hit rate >= 85 %; sim `hiccups` stale <= 1). Real: on the slowest phone in the group, fewer than 1 in 20 face-on taps at 3 m say CAMERA TOO SLOW. <!-- R4.02 auto:sim.slowPhone -->
- [ ] **Must**: Every FIRE press produces exactly one visible verdict within 1 s on a fast phone and within the burst allowance (up to 900 ms plus frame period) on a slow one: HIT name, name ELIMINATED, MISS, UNCLEAR TARGET, THAT IS YOU, NOT A PLAYER, CAMERA TOO SLOW, NO CAMERA LOCK, or NO FRESH FRAMES. No silent taps. <!-- R4.03 auto:test:every fire gets a verdict -->
- [ ] **Must**: A hit costs exactly one life on the target's phone, once, even when two shooters hit the same target within the shield window (`invulnMs`, default 3 s, never below 0.5 s): the second gets MISS or the target's shield status, the target loses one life, not two. <!-- R4.04 auto:test:one life per hit inside the shield -->
- [ ] **Must**: Cooldown (default 1 s) is enforced on the shooter's phone; mashing FIRE never fires twice in one cooldown. <!-- R4.05 e2e:cooldown -->
- [ ] **Should**: The green crosshair with the name appears before the tap in at least 80 % of the taps that end as hits (the lock predicts the verdict; players learn to wait for green). <!-- R4.06 phone -->
- [ ] **Should**: MISS and UNCLEAR TARGET are distinguishable to players: MISS when nobody is under the dot, UNCLEAR TARGET when someone is but identity is not settled. In a 10-minute round, UNCLEAR TARGET on a clearly aimed, face-on, 3 m shot happens fewer than 1 time in 10. <!-- R4.07 phone -->
- [ ] **Should**: The shot log on the results screen explains every refused shot with the top beliefs, frame age, and stale allowance, and lists the calibration version. <!-- R4.08 auto:test:every shot log entry records the calibration version -->
- [ ] **Nice**: Median FIRE-to-verdict under 400 ms on the fastest phone in the group (measure from the shot log timestamps). <!-- R4.09 phone -->
- [ ] **Must**: Every refusal on the HUD (UNCLEAR TARGET, NOT A PLAYER, THAT IS YOU, CAMERA TOO SLOW, NO FRESH FRAMES, NO CAMERA LOCK, SHOT LOST, UNCONFIRMED, NOT COUNTED, IS ALREADY OUT) carries a second line saying what to do. <!-- R4.10 auto:test:verdict advice -->
- [ ] **Should**: Range mode says why FIRE is disabled until a target is chosen. <!-- R4.11 manual -->
- [ ] **Must**: A hit the server has not confirmed within 4 s is reported as "UNCONFIRMED" (it counts only if it reaches the server, in its own round, once) and its record and photo are closed, never left hanging behind a LOCKING banner; a write whose answer a dropped connection cut off (the SDK's `Error('disconnect')`, which may have landed) is UNCONFIRMED too and is sent again with its shot id; a write that was refused or never sent is "NO CONNECTION, SHOT LOST" or "SHOT LOST". <!-- R4.12 auto:test:a hit that cannot reach -->
- [ ] **Must**: A slow or throttled phone (frame period over 250 ms) sheds the extra face crop and samples clothing every other frame, keeping the crosshair target's crop, so the period stops growing; the shot rules are untouched and the slow-phone sim keeps its bound. <!-- R4.13 auto:test:work shedding -->
- [ ] **Should**: Every shot is reconstructable from its sample: calibration version, per-body vetoes, clothing age, unconfirmed/reacquiring, overlap and crowd flags, whether this frame's face was a fresh read, whose own outfit backed each face read, the observed hit region and bodies per frame; the offline replay applies the same refusals (the overlap/crowd rule from the body's latest read, at the bar the game judged it at). <!-- R4.14 auto:test:a recorded instant hit names nobody -->

## 5. Distance and pose table (what to hand players as expectations)

Fill this from the real range test (`debug` on, `range`, pick the target and distance, 20 taps per cell). The numbers are targets for a Demo-ready pass; "wrong" must be 0 in every cell.

| Distance | Face-on correct | Back view correct | Notes |
| --- | --- | --- | --- |
| 1.5 m | >= 90 % | >= 70 % (legs must be in frame) | face carries |
| 3 m | >= 85 % | >= 65 % | face and outfit |
| 4.5 m | >= 75 % | >= 60 % | face fading, outfit carries |
| 6 m | >= 60 % | >= 50 % | outfit only |
| 8 m | >= 45 % | >= 40 % | outfit only; UNCLEAR is the expected failure |

- [ ] **Must**: Every cell has wrong = 0. <!-- R5.01 phone -->
- [ ] **Should**: Every cell meets its target on the phones players actually use, in the demo venue's light. <!-- R5.02 phone -->
- [ ] **Nice**: Same table under dim light within 15 points of the good-light numbers. <!-- R5.03 phone -->

## 6. Many players, free-for-all (multiplayer at scale)

The demo is everyone against everyone: 3 lives, no respawn, last standing wins. No teams, so nothing in this section is about team colours or friendly fire.

- [ ] **Must**: 8 players enrol and start one round from one room code without anyone stuck; measure with a stopwatch, target under 3 minutes from "Create a room" to countdown for 8 guests (enrolment is the long pole: 8 head angles plus front and back body scans per player). <!-- R6.01 e2e:eight-players-start -->
- [ ] **Must**: The lobby shows every joined player with their enrolment state and blocks Start until all are enrolled, no outfit or face conflicts remain, and no stale (disconnected) player is left in the list. <!-- R6.02 e2e:lobby-gating -->
- [ ] **Must**: A hit registered on phone A appears on the target's phone B (lives drop, shield starts, sound plays) within 1 s on venue Wi-Fi or 4G, for every pairing, in a 12-player round. Test: each player is hit once by a named shooter; all 12 confirm lives dropped. <!-- R6.03 e2e:hit-propagates -->
- [ ] **Must**: Concurrent hits on different targets in the same second all land (atomic write per hit in `registerHit`); test with 4 pairs firing on a count of three, all 4 targets lose one life. <!-- R6.04 e2e:concurrent-hits -->
- [ ] **Must**: Elimination and the winner are consistent on every phone: when the last opponent is eliminated, all phones move to Results within 2 s and name the same winner. <!-- R6.05 e2e:winner-consistent -->
- [ ] **Must**: An eliminated player's phone says YOU ARE OUT, cannot fire, and cannot be hit again (`applyHit` returns `dead`); they can spectate or go back to the lobby without disturbing the round. <!-- R6.06 e2e:eliminated-out -->
- [ ] **Must**: Shield after a hit (default 3 s) is respected across phones: a second shooter hitting a shielded target in that window sees MISS, not a hit, and the target does not lose a second life. <!-- R6.07 e2e:shield -->
- [ ] **Must**: A player who loses connection mid-round and reopens the link rejoins the same room as the same player with the same lives (`joinRoom` returns `ok` for a returning player during a round, `in-progress` for a new one). <!-- R6.08 e2e:rejoin -->
- [ ] **Must**: A new player cannot join a round in progress; they see a clear message and can join the next round from the lobby. <!-- R6.09 e2e:join-in-progress -->
- [ ] **Must**: The host leaving the lobby or the round does not strand the room: another phone can still play the round out and the results screen still appears for everyone. <!-- R6.10 e2e:host-migration -->
- [ ] **Must**: A second round from the same lobby (host taps Back to lobby, then Start) resets lives, status, tags, and the shot feedback card for every player, with no leftover hits from the first round. <!-- R6.11 e2e:second-round -->
- [ ] **Should**: With 12 players in one room, each phone's frame period does not grow with player count (identity candidates are evaluated per track, not per player-frame), measured by comparing the bench `period` with 2 and 12 enrolled profiles. <!-- R6.12 phone -->
- [ ] **Should**: Six or more bodies in one camera frame (a cluster of players) do not stall the vision loop: frame period stays under 2x the single-body period on the slowest phone, and the crosshair target is still cropped every frame while unconfirmed. <!-- R6.13 phone -->
- [ ] **Should**: The lobby's outfit-conflict warning scales: with 12 players, the check runs in under 1 s on a midrange Android and names every conflicting pair, not just the first. <!-- R6.14 manual -->
- [ ] **Should**: Room codes avoid ambiguous letters (I, O are excluded from the alphabet) and a mistyped code gives "room not found" rather than creating a new room. <!-- R6.15 auto:test:room codes -->
- [ ] **Should**: Tags (hits landed) per player and the final standing are shown on Results for all players, sorted, so a 12-player round has a leaderboard, not just a winner (implemented in `src/screens/Results.tsx`; verify it agrees on every phone). <!-- R6.16 e2e:leaderboard -->
- [ ] **Nice**: A late player can enrol during the lobby while others are already enrolled without resetting anyone else. <!-- R6.17 manual -->
- [ ] **Nice**: A round timer or a "last 2 standing" call-out for big rounds, so a 12-player game does not drag when two cautious players remain. <!-- R6.18 manual -->
- [ ] **Must**: When an enrolled player's phone drops, the lobby names them ("Waiting for Pia's phone to reconnect") and marks them in the list, instead of claiming it needs more players. <!-- R6.19 e2e:lobby-reconnect -->
- [ ] **Should**: When neither the share sheet nor the clipboard works, the lobby shows the code to read out instead of doing nothing. <!-- R6.20 auto:test:share fallback -->
- [ ] **Should**: The Hit confidence field stops at 0.7 with a note, so a host cannot make every shot UNCLEAR for a round; the sound pill says the iPhone mute switch keeps sounds off. <!-- R6.21 manual -->
- [ ] **Must**: A phone that silently lost its network is noticed within a minute through a 20 s heartbeat, not only when Firebase's own socket timeout fires; host migration and the forfeit use the same rule, and the HUD counts the forfeit down by name. <!-- R6.22 auto:test:heartbeat presence -->
- [ ] **Must**: A hit lands at most once and only in the round it was fired in: one transaction over the players map checks that both players still carry the shot's round (`startAt`, stamped by `startRound`, cleared by `endRound`), records `players/{target}/shots/{shotId}`, retries when the SDK aborts it for the phone's own write, and a resent, doubled or late-queued write is never applied again or in the next round. <!-- R6.23 auto:test:duplicate shot id applies once -->
- [ ] **Must**: A hit write still queued after the 4 s deadline (shown as UNCONFIRMED) is refused inside the transaction if the round has ended by the time it reaches the server. <!-- R6.24 auto:test:a hit after the round ended is refused inside the transaction -->
- [ ] **Must**: The round's status moves only through transactions that re-check where they start (`startRound` from the lobby, `beginPlay` from that round's countdown, `endRound` while playing, `resetForNewRound` from that round's end), so a countdown flip, Start or Back to lobby that a phone buffered while offline or asleep cannot reopen an ended round, start a reset lobby, or wipe a round in progress. <!-- R6.25 auto:test:the countdown becomes play once -->

## 7. Using the app without bugs (robustness)

- [ ] **Must**: Enrolment completes on iOS Safari and Android Chrome without a dead end: camera permission prompt, 8 head angles, front and back body scans, the front scan's "learn your face from a distance" step, and the outfit check all succeed on both. Test each phone model in the group once. <!-- R7.01 phone -->
- [ ] **Must**: The camera permission being denied, or no rear camera, gives a clear message with a retry, never a blank screen. <!-- R7.02 e2e:camera-denied -->
- [ ] **Must**: The app survives backgrounding (call, notification, lock screen) and returns to the same screen with the camera restarted; the vision loop resumes within 3 s and shows NO FRESH FRAMES until it does. <!-- R7.03 phone -->
- [ ] **Must**: Rotating the phone or switching cameras mid-round does not crash, freeze the crosshair, or produce a hit from the pre-rotation frame. <!-- R7.04 phone -->
- [ ] **Must**: Ten minutes of continuous play on the warmest phone in the group: no crash, frame period grows by less than 50 % (thermal throttling is expected; a stall is not), and the wake lock keeps the screen on. <!-- R7.05 phone -->
- [ ] **Must**: Loss of network for 30 s mid-round: local play continues (aiming, locking, verdicts), hits queue or fail visibly, and the room resyncs when the network returns with no duplicated hits. <!-- R7.06 phone -->
- [ ] **Must**: No unhandled errors in the browser console across a full round (enrol, lobby, game, results, back to lobby) on the two most common phones. Check with remote inspector or `?debug`. <!-- R7.07 e2e:no-console-errors -->
- [ ] **Must**: The self-signed HTTPS dev certificate is accepted once per phone and does not need re-accepting during the demo, or the demo runs from the deployed GitHub Pages URL with a real certificate (preferred for a demo). <!-- R7.08 manual -->
- [ ] **Must**: Model download and warm-up on first open finish within 30 s on venue Wi-Fi, with a visible progress state; the PWA runtime-caches `/models/*` (`vite.config.ts`) so second opens are instant. Verify offline reopen on one phone. <!-- R7.09 phone -->
- [ ] **Should**: Sounds and haptics fire on hit, on being hit, on elimination, and on win, and are audible in a noisy room; iOS needs one user gesture before audio, so the first FIRE (or a "tap to start" on the countdown) unlocks it. <!-- R7.10 phone -->
- [ ] **Should**: The shot feedback card after a round works end to end: shows a failed shot's frame with the crosshair, uploads the numeric sample on Yes/No, uploads nothing on Skip or "I can't tell", and the photo is deleted from IndexedDB afterwards. Failed uploads retry on the next lobby or results screen. <!-- R7.11 auto:test:a burst records the frames after the tap -->
- [ ] **Should**: Battery: a 20-minute round costs under 25 % on a midrange phone with the torch off. <!-- R7.12 phone -->
- [ ] **Should**: Debug overlay and range mode can be turned on and off mid-round without breaking the game, and range mode shots deal no damage. <!-- R7.13 auto:test:the range-test recorder returns the same accuracy summary -->
- [ ] **Nice**: Install-to-home-screen works on both platforms and the installed app behaves identically to the browser tab. <!-- R7.14 phone -->
- [ ] **Must**: A stalled model download ends in a Retry button with a plain message, never a black camera: the loading text shows progress and a download with no progress for 45 s is abandoned. <!-- R7.15 auto:test:a stalled download -->
- [ ] **Must**: "Connecting" and "Rejoining your room" admit after 10 s that they are taking long and offer a Back button. <!-- R7.16 auto:test:still connecting -->
- [ ] **Should**: A failed rejoin after a reload says why on the Home screen instead of silently dropping the player. <!-- R7.17 auto:test:a failed rejoin -->
- [ ] **Must**: The host leaving on the results screen does not strand the room: another phone becomes host and gets "Back to lobby". <!-- R7.18 e2e:host-migration-results -->
- [ ] **Should**: The shot review lets a player skip one shot or finish reviewing, and a failed room reset says so and keeps the button. <!-- R7.19 manual -->
- [ ] **Should**: A waiting app update never reloads while the player is in a room, in the profile, or typing. <!-- R7.20 auto:test:update allowed -->
- [ ] **Should**: The crash notice speaks plainly and keeps the raw error behind a Details toggle. <!-- R7.21 auto:test:crash notice -->
- [ ] **Must**: A phone that loses its link to the room server shows OFFLINE in the game and the lobby while it lasts, instead of a HUD that looks live on cached state. <!-- R7.22 e2e:offline-pill -->
- [ ] **Must**: A vision loop that fails every frame (a lost graphics context, a broken detector) stops after ten failures, drops the models and shows the failure with a Retry that reloads them, instead of spinning silently for the rest of the evening. <!-- R7.23 auto:test:a vision loop that fails -->
- [ ] **Must**: While the browser's camera permission sheet is open the app waits a full minute, says "Waiting for you to allow the camera…", and never re-prompts with fallback constraints after a timeout. <!-- R7.24 auto:test:the camera permission sheet is waited for -->
- [ ] **Must**: The model cache keeps only complete responses under a versioned name, a load that finds a model missing clears it so Retry refetches, and an abandoned load releases its GPU tensors. <!-- R7.25 auto:test:the model cache is versioned -->
- [ ] **Should**: With several bodies in view, the spare face crop goes to whoever has no face sample yet, then to the oldest face, instead of a blind round-robin; the live-enrolment log and the range-test log are capped. <!-- R7.26 auto:test:crop priority -->
- [ ] **Should**: A whole round with the real models on a real clip as the camera: the person in frame is hit, a real distractor never is, everyone reaches Results. <!-- R7.27 e2e:real-vision-round -->
- [ ] **Should**: Practice mode works on one phone with the real models: a target captured with the rear camera, the verdict is right, the shot is logged with its label. <!-- R7.28 e2e:practice-solo -->
- [ ] **Should**: Range-test shots (practice, or debug > range in a real room) carry their set-up (distance, view, light, scenario) and their source (`practice` or `range`) in the label, are judged right or wrong by player id, keep their crosshair photo on the phone only and for at most `ROUND_TTL_MS` (expired rounds are dropped when the app starts, reviewed or not), and are reviewed on Results (photo, verdict, aim, set-up, filters, delete); the review card never asks about them. <!-- R7.29 auto:test:practice shots keep their photos -->
- [ ] **Should**: `npm run session:report` breaks labelled shots down by condition, target, phone and build with legit-shot success (rejections in the denominator), resolve and lock p50/p95, and exact one-sided 95 % Clopper-Pearson bounds per shot and per accepted hit, practice and review answers never pooled, with a held-out split. <!-- R7.30 auto:test:the practice totals count every outcome -->

## 8. Enrolment scan (face angles, body scans)

The eight-angle face scan and the two body scans are the first thing every player does; a scan that refuses a correct head turn or takes minutes is the demo's first failure. The prompt logic is pure (`src/vision/scan.ts`, tunables in `SCAN_CALIB`) so most of this is unit-tested; the timings need a phone.

Automated evidence: `tests/scan.test.ts` and the `[scan-smoke]` Playwright scenario (real models in Chrome).
Real-phone evidence: a rescan on the phones players use, with the yaw/pitch readout the face stage shows.

- [ ] **Must**: Each face prompt advances within 3 s of the player holding the correct pose (no prompt needs more than one try on a phone that shows the pose in the readout). <!-- R8.01 phone -->
- [ ] **Must**: Both turn directions work whatever the mirrored preview shows: left and right only have to be opposite ways, latched from the first turn. <!-- R8.02 auto:test:mirrored player -->
- [ ] **Must**: The hint names the actual correction: a turn that is too small says "turn a bit more", too large says "turn back", and "the other way" appears only when the direction is wrong. <!-- R8.03 auto:test:turn-less, not other-way -->
- [ ] **Must**: The same person is never refused for turning their head: the face stage takes no decision on face similarity (the one face in frame is the player), so no turn can read as "a different face". <!-- R8.04 auto:test:the face stage completes for a person who only turns one way -->
- [ ] **Must**: Chin up and chin down complete whatever sign the model gives pitch on the device. <!-- R8.05 auto:test:inverted pitch sign -->
- [ ] **Must**: The face scan completes in under 45 s and the whole enrolment (face, front and back body scans) in under 2 min on the slowest phone in the group. <!-- R8.06 phone -->
- [ ] **Must**: A 720p selfie at arm's length is not stuck on "Move closer": the enrolment face size gate is 48 px, not 64. <!-- R8.07 auto:test:minimum face size -->
- [ ] **Must**: The body stages keep their outfit samples through a step or a phone shift; only 1.5 s without a usable body starts over. <!-- R8.08 auto:test:movement does not lose -->
- [ ] **Must**: The models load, the camera starts and the face stage runs in a real browser without console errors. <!-- R8.09 e2e:scan-smoke -->
- [ ] **Should**: The face stage shows the measured yaw and pitch under the hint, so a phone can report what the model sees and `SCAN_CALIB` can be tuned from real numbers. <!-- R8.10 manual -->
- [ ] **Should**: The far-face step of the front body scan waits at most 6 s after the outfit is complete. <!-- R8.11 auto:test:far faces are waited -->
- [ ] **Should**: A signed-in player's deep scan is reused and only a complete scan from the current face model counts. <!-- R8.12 auto:test:a stored scan stands in for a face scan -->
- [ ] **Nice**: The yaw and pitch a real phone reports at a comfortable "slight" and "further" turn are written next to the bands in `SCAN_CALIB`. <!-- R8.13 manual -->
- [ ] **Must**: Somebody else in the frame pauses the body scan and keeps its samples; only 1.5 s of intrusion starts over, and the hint says which. <!-- R8.14 auto:test:a bystander pauses -->
- [ ] **Must**: The body scan's settle counts from the first usable body frame, not from a countdown that ended while the player was walking back. <!-- R8.15 auto:test:the settle counts -->
- [ ] **Should**: A small room gets an alternative to stepping back (raise the phone, tilt it down) and a scan without the legs still counts. <!-- R8.16 auto:test:small room -->
- [ ] **Should**: A propped phone stays awake through the scan, and the far-face wait is a bar and a tick per sample, readable from 3 m. <!-- R8.17 manual -->
- [ ] **Must**: A weak face detection names light as the fix, never "hold still"; each cheap gate (no face, several faces, crop) has one message. <!-- R8.18 auto:test:low light is named -->
- [ ] **Must**: The enrolment face size gate is measured in full-frame pixels, so a 720p phone is not held closer than a 1080p one. <!-- R8.19 auto:test:the face size gate is measured -->
- [ ] **Must**: A failed scan upload keeps the captured scan: the message says why in plain words, "Try again" re-sends it, and "Start over" is a separate link. <!-- R8.20 auto:test:a failed scan upload -->
- [ ] **Must**: A real person completes the eight-angle face scan with the real models without a dead end or a "different face" refusal: a real interview clip as the selfie camera reaches 8/8 (patience and Skip this angle for the moves the speaker never makes). <!-- R8.21 e2e:real-scan -->
- [ ] **Must**: No face-scan prompt can dead-end: after 6 s the best right-way frame stands in, after 10 s the angle can be skipped, and the face stage never refuses a sample on face similarity. <!-- R8.22 auto:test:the face stage completes for a person who only turns one way -->
- [ ] **Should**: Two people in the selfie frame never give a face sample, and the hint asks for one face. <!-- R8.23 e2e:real-scan-two-faces -->

## 9. Demo-day protocol (run this before the first guest picks up a phone)

Venue and people:

- [ ] Even, bright light with no large window behind where players stand; walls that do not match anyone's top.
- [ ] Every player wears a bright, solid top, distinct from the others; keep two spare tops of unused colours for conflicts.
- [ ] 3 to 8 m of clear floor; a pillar or corner is fine and makes for good occlusion tests.

Phones:

- [ ] Every phone opened the deployed URL once on the venue Wi-Fi, accepted the camera permission, and the models are cached (second open is instant).
- [ ] Every phone is above 50 % battery, brightness up, Do Not Disturb on, auto-lock off or the wake lock verified.
- [ ] The slowest phone's bench (`?bench`, Sample person, then Range sweep) has been run in the venue: note `period` and where the face gives out; that is the honest range for the room.

Smoke round (host plus two players, 3 minutes):

- [ ] Enrol, start, each player hits each other player once face-on at 3 m and once from behind at 3 m; every hit lands on the target's phone within 1 s.
- [ ] One player stands next to a non-player: aiming at the non-player gives NOT A PLAYER.
- [ ] One player walks in front of another while the host aims at the one behind: no hit lands during the crossing.
- [ ] Eliminate one player; they see YOU ARE OUT and the round ends with the right winner on all three phones.
- [ ] Back to lobby, second round starts clean.

Recording:

- [ ] Open the host's phone with `?record` and record the smoke round; save the JSON under `recordings/<date>/` named per `docs/validation.md`; run `node scripts/validate.mjs recordings/<date>` afterwards and file the totals in `TRACKING_IMPROVEMENT_PLAN.md` next to the calibration version.

Go / no-go:

- [ ] Every Must in sections 1, 4, 6 and 7 was green in the smoke round. If any Must in section 1 fails, do not run the demo with real scores; run it as a range-test demo instead (range mode deals no damage).

## 10. Automated gates to keep green on every tracking change

- [ ] `npm test` (unit tests, pipeline pins, 3-seed sim round, replay fixture)
- [ ] `npm run typecheck`
- [ ] `npm run sim -- --seeds 100` (read the table; hit rates near their floors are a warning)
- [ ] `npm run sim:full` (exit 0)
- [ ] `npm run build`
- [ ] `node scripts/validate.mjs recordings/<latest>` (exit 0, once real recordings exist)
- [ ] `CALIBRATION_VERSION` bumped and README thresholds updated whenever a constant in `src/vision/calibration.ts` changes.

## 11. What is already covered and what still needs phones

Covered by automation today (2026-09-17): every sim item in sections 1 to 4, the tap-time rule, the hit resolution race, and the replay fixture. Not yet measured, and only phones can settle it: the real-phone columns in sections 1, 3, 5, 8 and 9, everything in section 6 at 8 or more players, and section 7 on iOS Safari and Android Chrome. The validation set in `docs/validation.md` is the first job; this rubric says what a passing set looks like.
