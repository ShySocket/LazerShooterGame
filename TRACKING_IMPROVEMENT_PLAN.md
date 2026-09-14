# Tracking review and improvement instructions

Reviewed September 13, 2026 against the working tree, including its existing uncommitted changes. This document proposes changes; this review modified only this document. Findings come from source inspection, existing tests, and additional deterministic probes. Real-phone video accuracy and performance were not measured during this review.

Face-centering and calibration changes appeared from concurrent work during final verification. The earlier simulation failures below belong to the initial snapshot; all three isolated cases pass on the later snapshot. However, the expanded later run still found one wrong hit and one wrong-lock frame, now at different seeds. The review includes those later cases and a separately reproduced cache bug in the new face-centering implementation. Preserve the earlier cases as regressions rather than presenting them as failures of the later code.

The highest priority is preventing identity and aim errors. Improve continuity and latency after those errors have regression tests. Raising hit confidence or extending tracking timeouts alone will not address the underlying problems.

**1. Current behavior and verified baseline**

The game detects people with MoveNet and face boxes with BlazeFace. It associates faces with bodies, matches body boxes across frames, samples outfit colors and body proportions, and runs InsightFace on selected square crops. Each track accumulates identity scores; FIRE selects the body containing the center dot and either resolves immediately or waits for additional frames.

Keep the existing useful safeguards: serialized access to Human, immutable camera pixels during a processing session, square face crops, face/body ownership checks, self and stranger candidates, identity conflict detection, snapshots of published tracks, and post-tap confirmation for pending shots.

| Check | Result on the initial review snapshot |
| --- | --- |
| `npm test` | All 69 tests passed. |
| `npm run typecheck` | Passed. |
| `npm run sim` | 16 scenarios reported zero wrong hits with the default three seeds. |
| `npm run sim -- --seeds 100` | Occlusion reported one wrong hit out of 1,500 shots; stranger reported two wrong-lock frames. The report still exited successfully. |
| Isolated occlusion regression | Seed 39: FIRE at 9,300 ms resolved to Bob while the simulated aim was on Alice. |
| Isolated stranger regressions | Seeds 45 and 61: one incorrect player-lock frame each; no wrong shots in these runs. |

The initial simulated failures are not estimates of real-world error rates. The simulation also has limitations described below. After the concurrent face changes, all 69 tests and type checking passed again; isolated occlusion seed 39 and stranger seeds 45 and 61 reported zero wrong hits and zero wrong locks.

The later 100-seed run still reported one wrong hit in 1,500 occlusion shots and one stranger wrong-lock frame, with exit status 0. The later reproducible cases are **occlusion seed 60** (Bob hit at 9,300 ms) and **stranger seed 23** (one false player-lock frame). These are the current regression failures as of final verification. Passing short-vector and synthetic tests does not validate the real 512-dimensional face-centering path.

**2. First change: make the discovered failures permanent tests**

Work in [simulation tests](/Users/saibhandar/Documents/GitHub/LazerShooterGame/tests/sim.test.ts:10), [simulation engine](/Users/saibhandar/Documents/GitHub/LazerShooterGame/tests/sim/engine.ts:101), and [simulation report](/Users/saibhandar/Documents/GitHub/LazerShooterGame/tests/sim/report.ts).

1. Add occlusion seed 60 and stranger seed 23 as named regression tests; these fail on the later snapshot. Also retain occlusion seed 39 and stranger seeds 45 and 61, which exposed errors in the initial snapshot and now pass after concurrent recognition changes. Assert zero wrong hits and zero wrong-lock frames separately.
2. Keep a small deterministic set for quick local checks and run seeds 1–100 in the broader validation suite. Make regression failures return a nonzero exit status; the current printed report is not an acceptance gate.
3. Save a compact event trace around a wrong decision: tap time, frame capture/copy/completion times, physical person ID, track ID, bounding box, match alternatives, raw face similarities, clothing region quality, identity scores, and shot verdict.
4. Correct the simulation clock. Currently, the scene advances at frame capture and stays frozen while simulated inference and FIRE events occur. Use an immutable scene snapshot for detector outputs and a separately evaluated world state at every tap. Do not reuse capture-time ground truth to judge a later shot.
5. Define the intended hit target explicitly. Currently any eligible, padded body rectangle under the dot can count as correct. Label the visible person at the aim point; if visibility is unknown during overlap, label the case ambiguous. Do not automatically credit a hidden player.
6. Add image-based replay alongside synthetic observations. Synthetic clothing comes from the true person's ideal signature, bypassing clothing pixel extraction, blur, background contamination, and occluders.

Acceptance: all five regression cases pass after fixes; wrong-hit and wrong-lock counts are enforced; a target walking away during inference produces a miss or a request for fresh confirmation.

To run the later failures and retain the earlier regression cases from the repository root:

```sh
node --import ./tests/register.mjs --input-type=module <<'JS'
import { simulate, SCENARIOS } from './tests/sim/engine.ts';
for (const [name, seed] of [['occlusion', 60], ['stranger', 23], ['occlusion', 39], ['stranger', 45], ['stranger', 61]]) {
  const result = await simulate(SCENARIOS.find(s => s.name === name), { seed });
  console.log({
    name, seed, counts: result.counts,
    wrongLockFrames: result.wrongLockFrames,
    wrongShots: result.shots.filter(s => s.outcome === 'wrong'),
  });
}
JS
```

**3. Highest priority: separate identity memory from current aim**

Relevant code: [frame freshness](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/shot.ts:8), [instant shot resolution](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/pipeline.ts:311), and [lock display](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/screens/Game.tsx:342).

The current freshness allowance grows with the frame period. At a 300 ms period, geometry up to 750 ms old qualifies for an instant hit; the ceiling is 1,100 ms. Remembering who a player is for that long is useful, but their old position does not establish who is under the dot now. The stricter post-tap checks apply to pending shots, not confident instant shots.

Implementation instructions:

1. Track separate timestamps for the last observed position, last reliable identity evidence, and frame completion. Keep separate budgets for using geometry and remembering identity.
2. Set an explicit initial geometry-age budget, for example 150–250 ms, and evaluate it with real motion recordings. This is a proposed starting range, not a measured optimum. A slow inference period must not automatically widen this budget to a second.
3. When existing geometry exceeds the budget, retain the identity as a candidate but require a new position observation. Prioritize a frame copied at FIRE if feasible. Ensure queued inference cannot replace its pixels with a later frame.
4. Define the game rule for borderline shots. A frame copied at FIRE measures aim near the tap. A later confirmation frame implements a short hold-on-target rule; document that behavior and cap the delay. Do not describe a later frame as proof of the exact tap-time aim.
5. Preserve pending-shot linkage to the same physical track. Add an identity/continuity generation that changes when continuity is broken; cancel a pending shot if that generation changes. If a shot began with an accepted player identity, do not let it silently resolve to another player after a reset.
6. Add a watchdog independent of successful inference callbacks. Expire the green LOCK and stale overlay when camera frames or completed observations stop progressing. Current inference errors only log and retry, so the old lock can remain visible.

Acceptance: lock onto Alice, then move the phone off her before FIRE while delaying inference by 400–800 ms. No old-position instant hit is allowed. Also test a frozen camera, repeated inference errors, tab resume, and a second person entering the aim point during a pending shot.

**4. Highest priority: use observed body regions for hit testing**

Relevant code: [face-derived body box](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/tracker.ts:81) and [center-dot selection](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/geometry.ts:59).

A face-only observation creates a rectangle three face widths wide and 7.6 face heights tall. That rectangle is used for shooting as well as continuity. A probe with face box `[0.4, 0.1, 0.1, 0.1]` selected a target at aim point `[0.45, 0.65]`, far below the observed face. That area might contain a body, empty space, or an obstacle.

Implementation instructions:

1. Split `Detection.box` into a tracking region and explicitly observed hit regions, or introduce equivalent fields without immediately removing the existing box.
2. Keep the inferred face-to-body rectangle for matching and searching. A face-only observation should expose only the observed face as hittable if head shots are allowed; otherwise require body evidence.
3. For poses, build a torso polygon from reliable shoulders and hips. Add limb regions only if the game rules allow them and the necessary landmarks are reliable. Avoid counting the empty corners of the outer person rectangle as body.
4. Mark uncertainty where people or obstacles overlap. Pose landmarks alone do not prove the intervening pixels are visible. Use conservative rejection initially; evaluate segmentation later if overlapping play is common.
5. Share the same hit-region selector between the live lock, FIRE, pending confirmation, debug overlay, and test oracle.

Acceptance: face visible above a wall, crouching, a raised arm beside empty space, and two overlapping people must not create hits on inferred or unobserved torso areas. The debug overlay should show exactly which region can take a hit.

**5. Fix motion prediction and elapsed-time continuity**

Relevant code: [track lifetime and eligibility](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/tracker.ts:162) and [prediction and matching](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/tracker.ts:199).

Two direct probes exposed inconsistent behavior:

- With 400 ms between frames, a box moving from x=0.10 to 0.20, one missed detection, then x=0.40 received track IDs `1, 1, 2` despite perfectly constant motion and an allowed 1,100 ms gap. Prediction uses at most 250 ms of velocity, leaving it far behind the person after the dropout.
- A track observed at 100 ms and again at 1,400 ms retained its old identity with the default 450 ms gap setting. The “seen in the previous update” condition bypasses the elapsed-time gap check until the 1,500 ms overall lifetime expires.

Implementation instructions:

1. Apply elapsed-time validity to every candidate, including one seen in the previous update. A long pause must enter an uncertain reacquisition state even if no empty detector update occurred during that pause.
2. Predict to the actual observation timestamp. Replace the fixed 250 ms prediction cap with an uncertainty-aware model; do not simply remove the cap and accept arbitrary extrapolation.
3. Maintain center, size, velocity, and uncertainty. Start with a small Kalman filter or a time-aware alpha-beta filter. Increase uncertainty with time, missed observations, abrupt motion, and weak detections.
4. Track scale change as well as center motion, so approaching players do not fail shape gates solely because their boxes grow.
5. Distinguish tentative, confirmed, temporarily lost, and retired tracks. A temporarily lost track can remain available for matching but cannot authorize a hit from prediction alone.
6. Reject stale identity reuse after an uncertain gap. Use fresh appearance evidence to reconnect a person when appropriate; otherwise start a new identity hypothesis.
7. For the visual overlay, interpolate or briefly predict between measured frames. Keep that visual smoothing separate from authoritative shot geometry.

Kalman prediction with global assignment is an established lightweight starting point in [SORT](https://arxiv.org/abs/1602.00763). The appropriate uncertainty and timing settings for this phone game still require measurement.

Acceptance: repeat constant-motion, dropout, pause, acceleration, abrupt reversal, approaching, and leaving/re-entering cases at 100, 200, and 400 ms frame periods. Predictable unambiguous motion should preserve continuity; a replacement person must not inherit old identity.

**6. Add appearance to matching, while preserving ambiguity rejection**

Relevant code: [spatial matching](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/tracker.ts:199) and [observation processing order](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/pipeline.ts:191).

Matching currently considers box overlap, center distance, and shape. Faces and outfits update identity only after a spatial match has already transferred the old track's memory. Crossing players, abrupt camera motion, and overlapping boxes can therefore produce churn or a bad transfer before appearance is considered.

Implementation instructions:

1. Build a per-detection observation before committing a match. Include timestamp, body confidence, usable keypoints, clothing region descriptors with quality, and already available face observations.
2. Maintain a small reliable appearance history for each track. Compare new observations to the track's observed appearance, rather than using its guessed player name as proof that a match is correct.
3. Reject implausible pairs using motion uncertainty, shape compatibility, and strong appearance contradictions. Missing appearance should abstain; matching shirts must not overpower contradictory faces.
4. For remaining pairs, calculate a combined cost from motion, overlap, visible appearance, and reliable pose geometry. Tune weights on held-out recordings; do not assume arbitrary weights are calibrated.
5. Solve a one-to-one assignment with explicit unmatched options. A Hungarian solver can handle the small player count, but global optimization alone is not evidence of identity. Check ambiguity against alternative assignments and abstain when competing solutions are too close.
6. Avoid updating appearance history from ambiguous, clipped, heavily occluded, or low-quality matches. Require additional evidence after an ambiguous crossing before restoring a shootable identity.
7. Add camera-motion handling only after baseline measurement: estimate background motion and compensate predictions, or increase uncertainty and invalidate locks during a rapid pan. A stationary player moving across the image is not necessarily moving in the world.

Appearance-assisted association follows the principle demonstrated by [Deep SORT](https://arxiv.org/abs/1703.07402). Start with the descriptors the game already computes; benchmark a new person re-identification model only if those descriptors remain insufficient.

Acceptance: reverse detector output ordering, cross players in both directions, use identical tops, hide one person briefly, and pan the phone during a crossing. Preserve identity when evidence distinguishes people; show uncertainty when it does not.

**7. Recalibrate identity evidence and make missing data abstain**

Relevant code: [face calibration](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/embedding.ts:7), [evidence scoring](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/scoring.ts:24), [clothing coverage](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/clothing.ts:237), and [belief updates](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/scoring.ts:153).

Three current implementation problems need separate fixes:

- The newly added [face-centering cache](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/embedding.ts:66) keys results by array identity, but `updateFaceMean()` mutates its mean array in place. A valid 512-dimensional probe updating a mean toward a new face six times kept returning cached similarity 0.66948, while a fresh calculation on the updated mean rose from 0.91303 to 0.99770. Both recognition and the discontinuity check can therefore use a stale mean. Fix this before evaluating temporal recognition quality.
- Clothing similarity normalizes over whichever regions are present. A perfectly matching shirt alone can score 1.0 against a complete outfit. Without other signals, that becomes up to 0.85 evidence, despite missing the pants and hair that might distinguish a stranger.
- `bodyEvidence()` can return an empty object when no stored body reference is compatible. Evidence fusion still counts the body weight. In a probe with clothing similarity 0.72, clothing evidence falls from approximately 0.656 to 0.492 simply because a live body observation exists but the reference is missing. An absent reference is not negative evidence.

Implementation instructions:

1. Make the running face mean immutable: assign a newly normalized array after each update. Alternatively, cache only immutable profile embeddings and always recompute live means. Add a 512-dimensional test asserting that the cached comparison equals comparison against a fresh copy after every update. Current short-vector tests and the 64-dimensional simulation bypass the new centering path. Then make empty signal maps absent, and handle missing per-candidate body references as abstentions. Use explicit availability masks and calibrate the resulting comparisons; candidates with different available signals must not gain an accidental denominator advantage.
2. Return clothing similarity, region coverage, pixel count, pose confidence, and occlusion quality separately. Do not convert “excellent shirt match” directly into “excellent person match.”
3. Require stronger evidence to acquire a new identity than to maintain a securely established identity. Shirt-only evidence may support continuity but should not automatically establish a new shootable player identity. Keep a route for strong, distinctive multi-region outfit acquisition so back shots remain possible.
4. Keep separate face, clothing, and continuity histories with timestamps. Fuse current quality-weighted evidence once per frame. At present, separate clothing and face updates apply frame-count-dependent smoothing and can give different results at different processing rates.
5. Use elapsed-time smoothing, such as `alpha = 1 - exp(-dt / tau)`, with calibrated time constants and minimum independent observations. Repeated nearly identical frames must not be treated as independent proof.
6. Suspend shooting on a strong contradiction immediately. Then collect enough good evidence to either restore the old identity or establish a new one. Do not blend two people's face embeddings into one apparently stable identity. Weight accepted face samples by source sharpness, exposure, pose, clipping, and landmark quality as well as pixel size; a magnified blurry face does not contain new detail. Suppress body-ratio evidence when a sideways pose or occlusion makes the proportions unreliable.
7. Calibrate on separate enrollment and gameplay recordings, including strangers. Evaluate the maximum similarity across each player's whole enrollment gallery, all competing players, quality bands, and the full temporal decision path. Single image-pair statistics do not calibrate the actual game decision. The concurrent calibration's genuine examples use downscaled copies of the same image; add independent captures before drawing conclusions about gameplay recognition.
8. Select thresholds using false hits, false locks, missed hits, and acquisition time on a held-out set. Keep the numeric score labeled as confidence/score unless it has been calibrated as a probability. Version the centering mean, thresholds, and scoring behavior separately from the raw embedding model, and record that version in results. Because stored vectors remain raw, normalized embeddings, changing comparison calibration does not itself require a new face scan.

Acceptance: a 512-dimensional running mean produces up-to-date comparisons after every update; held-out impostor sequences do not produce a player lock; a stranger wearing a matching shirt remains unknown; missing body references do not reduce otherwise unchanged clothing evidence; similar evidence streams at different frame rates give comparable outcomes over time.

**8. Protect clothing samples during occlusion and improve enrollment**

Relevant code: [clothing pixel sampling](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/clothing.ts:153), [outfit observation](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/screens/Game.tsx:320), and [face enrollment](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/screens/Scanner.tsx:216).

Clothing samples come from pose quadrilaterals without a person-visibility mask. Another player's shirt can occupy those pixels while the underlying pose still looks plausible. Enrollment also displays eight head-angle prompts but only checks that the first face is roughly frontal and later yaw is within 45 degrees; repeated frontal samples can complete the scan.

Implementation instructions:

1. Pass nearby detections into clothing sampling. Initially, abstain on regions with substantial overlap where ownership is uncertain. If adding segmentation, use the mask to exclude background and other people, and include its runtime cost in measurements.
2. Report region quality and retain only clean observations in each track's appearance history. Compare a short robust history rather than allowing one contaminated patch to change identity.
3. Occasionally audit clothing even while a face-derived identity is fresh, especially after risky motion or a crossing. The present face-fresh shortcut can skip clothing checks for 1,500 ms. Treat reliable contradiction as a reason to verify, not immediate proof of another identity.
4. Define actual signed yaw and pitch ranges for enrollment steps. The current absolute-yaw helper cannot distinguish left from right. Check roll only for prompts that need it, and account for mirrored preview directions.
5. Accept an enrollment sample only after a short stable hold in the requested pose with adequate source-pixel size and image quality. Keep a few good samples per pose bin rather than filling the gallery with near-duplicates.
6. Capture independent front/back outfit observations and a few useful gameplay-distance face samples. Store quality and pose metadata; version the scan format if these fields become required, and make old scans upgradeable through rescan.
7. Compare outfit ambiguity by visible subsets as well as the full outfit. Players with identical shirts and different pants remain difficult to distinguish when the camera only sees their upper bodies.

Acceptance: remaining motionless cannot complete all angle prompts; left/right steps are verified; a foreground player does not contaminate the rear player's stored appearance; partial-body views cannot rely on invisible clothing differences.

**9. Improve processing speed without weakening shot rules**

Relevant code: [camera-frame loop](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/hooks/useVisionLoop.ts:39), [crop scheduling](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/pipeline.ts:228), [Human passes](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/vision/human.ts:45), and [camera acquisition](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/hooks/useCamera.ts).

1. Measure camera-copy time, body/face-box inference, each embedding crop, clothing readback, tracking, and total frame age. Report median and 95th percentile under one, two, and six visible people, plus a sustained warm-device run.
2. Schedule work from newly presented video frames where supported. Feature-detect `requestVideoFrameCallback`; use frame metadata and optional capture time, and keep a fallback. Current `capturedAt` is stamped after the canvas copy, so it measures application sampling time rather than guaranteed sensor capture time. The [video-frame callback specification](https://wicg.github.io/video-rvfc/) defines the available timestamps and optional capture metadata.
3. Preserve single-session Human access and immutable frame pixels. Drop superseded work instead of allowing a backlog of increasingly old frames.
4. Make face crops depend on need: pending shot, uncertain target, conflicting identity, newly detected person, or refresh age. The current crosshair target gets a crop every processed frame even when identity is already strong. Use a bounded refresh interval to preserve contradiction detection. Fix the background acquisition gap: a lone off-center person currently gets no crop, and background bodies without detected faces receive no exploratory head crop. Give those bodies occasional head-region checks so identity can be ready when the shooter aims at them.
5. Separate expensive recognition refresh from frequent position observations. Benchmark a bounded-resolution detector input while retaining the original frame for face and clothing crops. Keep coordinate transforms explicit and validate range recall before lowering resolution.
6. Publish each completed geometry observation promptly, with its own timestamp. If recognition finishes later, accept it only for the same track and continuity generation. Do not expose mutable intermediate results to FIRE.
7. Consider a second association pass for lower-confidence detections to maintain existing tracks. Lower-confidence boxes must not create new identities or authorize shots. Both the model's output threshold and the application filter need to retain such boxes for this to work. This is the limited recovery principle described by [ByteTrack](https://arxiv.org/abs/2110.06864), not a recommendation to trust every detection.
8. Fix camera timeout cleanup: a `getUserMedia` request that resolves after timeout must have all of its tracks stopped. Stop superseded streams after camera switching or unmounting; a timeout does not cancel the original permission/media promise.

Acceptance: the same validation clips show reduced frame age without more wrong hits or locks. A delayed camera request leaves no unused live stream. A busy/slow phone reports uncertainty promptly rather than extending the age of a hittable position.

**10. Real-phone validation and delivery order**

The existing [bench](/Users/saibhandar/Documents/GitHub/LazerShooterGame/src/bench/Bench.tsx:216) enrolls from a photo and then evaluates transformed views of the same photo. It is useful for model loading, coordinate transformations, and device throughput. Its nominal distances and same-photo recognition should not be treated as independent evidence of real range or identification accuracy.

Build a replay/phone test set using different enrollment and evaluation captures. Record actual distance, camera resolution, visible source face size, device/browser, and lighting. Include at least one older iPhone and one midrange Android, then expand to the phones players actually use.

| Scenario | What to measure or enforce |
| --- | --- |
| Stationary front view at 1.5, 3, 4.5, 6, and 8 m | Body/face recall, source face pixels, first-lock time, correct-hit rate. |
| Moving front/back view | Track fragmentation, reacquisition time, wrong locks, and wrong hits. |
| Crossings, reversals, and foreground occlusion | No transferred identity; no hits on hidden players. |
| Matching shirts, strangers, partial bodies | No new identity based solely on unavailable distinguishing regions. |
| Camera pan/shake and walk-out before FIRE | No hits from obsolete aim geometry. |
| Low light, backlight, blur, and warm device | Quality drops visibly; frame age and error rates are recorded. |
| Freeze, pause/resume, rotate, and camera switch | Old locks expire; pending shots are invalidated; streams are cleaned up. |

Use zero wrong hits and zero wrong locks as deterministic regression requirements. For field tests, report counts and denominators; zero observed errors in a small sample is not proof of zero error probability. Compare legitimate hit rate and acquisition/reacquisition latency only after false-hit regressions pass.

Suggested delivery sequence:

1. **Regression and observability change:** add known failing seeds, accurate tap-time ground truth, and decision traces.
2. **Immediate correctness change:** repair the mutable face-mean cache and add a 512-dimensional regression; separate identity age from geometry age, use observed hit regions, invalidate stale locks, and protect pending shots across continuity resets. These can be separate small changes for easier review.
3. **Tracking change:** enforce elapsed gaps, add time-aware prediction/uncertainty, and introduce appearance-assisted assignment with explicit unmatched states.
4. **Recognition change:** fix missing-data fusion, incorporate clothing coverage/quality, calibrate temporal identity decisions, and validate enrollment poses.
5. **Performance change:** profile, schedule recognition adaptively, recover weak detections conservatively, and clean up late camera streams.

Run the existing tests and type checks for each change, the expanded simulation for tracking/decision changes, and the same held-out phone recordings before comparing improvements. Keep model replacement as a later measured experiment if detection recall remains the dominant limitation.
