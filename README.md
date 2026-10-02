# Lazer Shooter

Real-life laser tag played with phones. Everyone opens the same link, enrolls their face and outfit, and then hunts each other with the rear camera. Press FIRE while another player is in the crosshair and their phone takes the hit.

- **Mobile web app (PWA)**: no app store. iPhone and Android both work in the browser.
- **Free multiplayer**: Firebase Realtime Database free tier syncs rooms, lives, and hits. Optional Google sign-in stores a one-time scan per account.
- **On-device vision**: face recognition, body pose, and clothing colour all run on the shooter's phone. Only numeric signatures are shared, never photos, including in the shot review after a round.
- **Rules**: 3 lives, no respawn, last player standing wins. Cooldown and shield times are tunable in the lobby (the shield after a hit never below 0.5 s).

## How a hit is decided

Each body the camera sees gets a running belief of who it is, built from four signals:

1. **Face recognition** with an InsightFace (ArcFace-family) model against the 8 head angles captured at enrollment. Strongest signal, only works within ~3 m and within about 45° of face-on. Cosine similarity, thresholds in `src/vision/embedding.ts`.
2. **Identity tracking**: once a body is recognised it stays recognised while it remains in frame, even when it turns around.
3. **Outfit signature**: colour histograms of the top, thighs, shins, and hair, captured front and back at enrollment. This is what makes back-shots and long-range shots work. The lobby refuses to start if two players' whole outfits look too alike. A match is weighed by how much of the outfit was actually compared, and acquiring an identity from clothing needs the trousers in view as well as the top (a shirt alone, or shirt and hair, can keep an identity the face already established but cannot start one), while a clearly different top or trousers rules the outfit out however well the rest matches. From behind at close range, keep the legs in frame.
4. **Body proportions**: shoulder, hip, leg, and head ratios from the pose model. A weak tiebreaker that survives a change of clothes.

Two decoys compete with the real players: the shooter's own profile, so a mirror or a look-alike resolves to YOU, and a stranger baseline that wins whenever nobody matches well. A shot only counts when a live opponent is above the hit confidence and clearly ahead of everyone else, decoys included. Otherwise the app says UNCLEAR TARGET, THAT IS YOU, or NOT A PLAYER instead of guessing.

Where a shot may land is the part of the person the pose model actually observed: the head and the torso between the shoulders and hips, never arms, legs, or the empty corners of the outer box, and a face seen without a body offers only the head. A shot decides instantly only from geometry under 250 ms old; an older frame can nominate who was under the dot, or whose motion since that frame carries them there, after which the same person must be seen there again in a frame captured after the tap. The aim is refused when another body's edge is within a few percent of the dot, or when somebody seen a moment ago still covers it, where they were or where their motion has carried them since (a pan carries a skipped person off their last box). A face found without head landmarks on a body goes with that body only above and between its shoulders, so the face of somebody behind never stretches its hit region.

When the evidence cannot tell the target apart, there is no hit. Concretely (`src/vision/scoring.ts: resolveHit`, `src/vision/tracker.ts: markUncertain`):

- **An identity is re-earned after anything that could have swapped it**: two bodies crossing or overlapping, a track reclaimed after a gap, a jump in height or position, an ambiguous face, a body that a person skipped this frame would explain as well as the track that took it, an outfit read that one of the body's own earlier reads ruled out, or a single face read that clearly names somebody else. The body's face average and samples are dropped and it needs two fresh face samples, or two clothing samples at least 150 ms apart (`CLOTHING_INTERVAL_MS`: reads closer together are one moment seen twice), before it may lock or hit again. A burst that started before such a transition never lands after it.
- **A face is backed by the player's own outfit.** A face names a player at the normal bar (`FACE_CALIB`) only while a clothing sample on this body within the last 3 s matched that player's scanned outfit, outside any overlap; otherwise, and for a candidate with no outfit on file, it must clear the strict bar (`FACE_ONLY_CALIB`). A contradicting outfit (`OUTFIT_VETO`) rules the player out on that body until a readable sample clears it; a partial match only starts a 4 s countdown. Missing or unreadable clothing is unknown, never a contradiction.
- **While somebody may be hidden behind the body** (they overlapped it, or, once tracked over two frames or more, vanished over where it now stands, and have not been seen apart from it since, up to 4 s, `HIDDEN_PARTNER_MS`; a body the detector found in one frame only is too often a ghost or a flicker to presume anybody hidden), the detector may hand the track their body in any frame. Each frame's identity then stands on that frame's own reads: its own face read must name the player (the body's face average cannot), the outfit is checked on every frame (a slow phone that sheds work never sheds this read, and a phone faster than the 150 ms clothing interval reads it on every frame too), and an earlier outfit match backs the face only when this frame's outfit still agrees. A face read counts only when it sits on the body's own head (the pose model's nose, or the middle of its other head landmarks, inside the face box), because the face of the person in front can turn up beside the head of the person behind, and the outfit read alone cannot confirm the name, because the person in front may fill the torso it samples: a back view with somebody hidden behind it waits until they are seen apart (or 4 s). A burst on such a body ends as a miss when a frame after the tap shows the dot off its torso, where the hidden person may be.
- **During an overlap, and in a crowded frame**, a hit needs this body's latest face read, taken in a frame captured at most 400 ms before the body's latest frame, to name the same player on its own by the full margin. The age is capture time against capture time, so a slow phone's processing time after the capture does not count against it (how old the frame itself may be is the shot-timing rule above). The pose model returns six bodies at most (`BODY_CAP`), so a frame with six may be missing someone; the HUD says "Too many people in view. Hits need a clear face."
- **An instant hit needs the body still under the dot** after its measured motion since the frame was taken; otherwise the tap waits for a frame captured after it.
- Every frame is fresh inference: Human's result caching is off (`cacheSensitivity: 0`, `skipFrames: 0`), so two agreeing frames are two observations, not one reused.
- **Every refusal names its rule** (`scoring.ts: explainHit`, `pipeline.ts: ShotRefusal`): no evidence, a hidden partner, unconfirmed, re-acquiring, a conflict, not a player, vetoed, no outfit backing (so the face met the strict bar), low confidence, margin, no fresh read in an overlap or crowd, and for bursts another player than at the tap, a transition after it, or no frame that could confirm it. The line under UNCLEAR TARGET says what to do about that rule (`advice.ts: refusalAdvice`), the shot log and the Practice review show it, shot samples carry it (v3: `shot.refusal`, and each frame's lock refusal), `npm run realcheck -- shoot` prints the unclear shots by rule, and `npm run session:report` the rejected player shots by rule.

Once the phone has decided, the hit goes to the room in one atomic write over the players map (`registerHit`, `evaluatePlayersHit` in `src/net/backend.ts`): it checks that shooter and target are still in the round the shot was fired in (every player carries that round's start time from `startRound` until `endRound` or the reset, both whole-room writes), takes the life, and records the shot in the target's ledger (`players/{id}/shots/{shotId}`, cleared when the next round starts). A shot is therefore applied at most once, and never in a round it was not fired in. The write covers the players map only (a few kB) rather than the whole room, whose profiles hold every player's face samples, and it is retried when the database SDK aborts it because the same phone wrote under the room meanwhile (its heartbeat, for instance), which the live e2e suite caught. The shield is judged at the shot's own time (the shooter's server clock when it sent the hit), never when the write is finally evaluated, so a second shooter's write that reaches the server late (a slow network, a re-run after the first shooter's commit, a phone that was offline) cannot outlast the shield the first hit started. The server's answer is shown as it is: HIT or ELIMINATED, the target's shield, IS ALREADY OUT, or NOT COUNTED when the round was over by the time the shot arrived. A hit the server has not answered within 4 s, or whose answer a dropped connection cut off, shows UNCONFIRMED: it counts only if it reached, or reaches, the server while that round is playing. A write still queued is sent when the phone reconnects; one the database SDK had already sent when the socket dropped is cancelled by the SDK with `Error('disconnect')`, since it cannot tell whether the server applied it, and `registerHit` sends it again with the same shot id, which the target's ledger answers as it landed. SHOT LOST is kept for writes that were refused or never left the phone.

The round's status moves only through guarded steps, each one transaction that re-checks the state it starts from: `startRound` only from the lobby, `beginPlay` (the end of the countdown, asked by the host's phone and, 1.5 s later, by every other phone) only from that round's countdown, `endRound` only while it is playing, and `resetForNewRound` (Back to lobby) only from that round's end. A Start, a countdown flip or a Back to lobby that a phone buffered while it was offline or asleep therefore re-runs on the room as it is when it arrives, and changes nothing if the room has moved on: it cannot reopen a round that ended, start a round from a reset lobby, or wipe a round another host started. `updateMeta` writes the lobby's settings only.

After a round, **Show my shot log** on the results screen lists every FIRE press with the top beliefs at that moment. Use it to see why a shot landed or did not.

## Shot review after a round

When the round ends, each player's results screen shows one of their own failed shots (a MISS, UNCLEAR TARGET or CAMERA TOO SLOW) as the camera frame from the moment they fired, with the crosshair drawn on it, and asks: **Did you clearly shoot another player when you did this shot?** The answers are "Yes, I shot <name>", "No, this should not count", "I can't tell from this photo" and Skip. Shots where a body was under the dot are preferred, and "Review another shot" offers the rest. The card stays through the host's Back to lobby.

- **The photo never leaves the phone.** It is kept in the browser's IndexedDB only until the answer, skip or the next round, then deleted.
- **What is uploaded** is the deconstruction of the shot: for the last 12 frames before the tap and every frame of the burst after it, each body's belief, the raw face similarity of that frame's embedding and of the track's running mean against every player, the outfit similarity and body-ratio similarity per player, and (sample v2) the players its outfit rules out, the age of its last outfit read, whether its identity was waiting to be re-earned, whether it overlapped someone or the frame was at the body cap, whether that frame's face was a fresh read, its hit region and the number of bodies in the frame, (v3) whether somebody was presumed hidden behind it, plus the target's face mean, outfit signature and ratios, the room settings, frame period, model names, app commit, calibration version, and the label. Player ids are replaced by `p0`, `p1`, ... (sorted order of the round's enrolled ids) and names are not included. The round's profiles (the same numeric signatures the room already shares) are written once per round next to the samples so they can be re-scored.
- "I can't tell" and Skip upload nothing. An upload that fails (no signal at the venue) waits on the phone and goes out the next time a results or lobby screen opens.
- Storage: `feedback/rounds/{CODE-startAt}/{profiles,samples}` in the Realtime Database, write-once and not readable by clients (`database.rules.json`). Local mode keeps samples in memory instead.

## Practice alone

Open the game with `?practice` (the home screen links to it as **Practice alone**) to test the tracking on one phone with nobody else playing. Everything stays on the phone except the shot log:

1. Type a name, tap **Start practice**, and do your own scan (it is the decoy for mirror shots).
2. In the lobby tap **Add a target**, point the back camera at a friend, a TV or a photo, and tap **Capture**. The largest person in view becomes *Target 1* (twelve frames, face and outfit; the note says if the hips were out of view and only the face was taken). Add as many as you like, then **Start game**.
3. Range mode and the debug overlay start on. FIRE unlocks once the countdown is over. Pick who you aim at (**Aim at**, or *Not a player* for anyone else) and tap the chips that describe the shot (distance 1.5 / 3 / 5 / 8 m, seen from front / side / back, light normal / dim / backlit, and what is happening: still, walking, crossing, occlusion, pan, look-alike, edge), fire, and the banner says **HIT Target 1 (right)**, **NO LOCK** or **WRONG: locked X, you aimed at Y**. Shots deal no damage. **What to try** lists the situations worth testing.
4. Every shot is uploaded at once to the shot feedback log below, labelled with the target you chose, the chips and where it came from (`source`: `practice` here, `range` for debug > range in a real room; queued when offline). Its crosshair photo stays on the phone: after **end round**, **Practice review** on the results screen lists every shot with its photo, the verdict and the set-up, filtered by Wrong, No lock or Right, until the next round, **Delete these photos** or six hours after the round started, whichever comes first (`ROUND_TTL_MS`: the app drops older rounds and their photos when it starts).

The same range test works in a real room (**debug**, then **range**): the targets are then players who did the normal scan, which is what `docs/phone-session.md` measures, and each shot is logged and reviewed the same way.

To read the log (the rules let no client read it, so this needs the project owner's login once):

```bash
npx firebase-tools login
npm run feedback:pull
```

`feedback:pull` saves the log under `.rubric/feedback/`, sorts every labelled shot into right hit, wrong hit, wrong hit on a non-player, right refusal and misses by cause, per build, lists every wrong one with its belief, and runs the calibration sweep below over the same shots. `--file export.json` reads a console export instead. Calibration is tuned on what it prints, so `--eval` (the same argument as the session report's, below) leaves the held-out rounds out of all of it and says how many samples and rounds it left out; `--since` drops older rounds. A `--since` or `--eval` value it cannot read stops it with exit code 2 and the reason.

`npm run session:report` (same fetch, or `--file` a saved pull) turns the same log into the session report (`src/feedback/sessionReport.ts`). Its sections are never pooled: `practice` (`?practice`, targets quick-enrolled with the rear camera, a face-only one held to `FACE_ONLY_CALIB`), `range` (range mode in a real room: players who did the normal scan, which is where the phone-session matrix is read), `practice/range (unsplit)` (labels taken at the tap, `reviewMs` 0, by a build that did not write the label's `source`, so the two cannot be told apart) and `review` (review-card answers, only ever failed shots). Each is broken down by condition (the label's `distance`, `view`, `lighting` and `scenario` when it carries them, otherwise `unlabelled`), by target player (round and `p<n>`, since ids are positional per round), by shooter phone (the user agent cut to e.g. `iPhone iOS 18.5 Safari 18.5`) and by build. Each row gives labelled shots, right hits, hits on another player, hits on someone labelled not a player, rejected legitimate shots, legit-shot success (right hits over every player-labelled shot, rejections included), resolve time p50/p95 of accepted hits, lock acquisition, and the exact one-sided 95% Clopper-Pearson upper bound on the wrong-hit rate (`src/feedback/stats.ts`). Lock acquisition is timed from the first recorded frame in which the shot's body (the track nominated at the tap, else the one decided on) is under the dot to the first frame in which that body is locked on the labelled target, so it measures the tracker and not how long the shooter held aim or how many milliseconds the 12 recorded pre-tap frames span: p50/p95 over the shots that locked, next to the count that were under the dot and never locked (failures) and the count already under the dot in the first recorded frame (`untimed`: when they came under it is unknown, and timing them from that frame would understate exactly the slow locks, so they are left out). The bound is given per round x target group, the shots at one person in one round, which share their light, outfit and enrolment and so are not independent, and per shot and per accepted hit only as if every shot were: no wrong hit at 18 targets bounds the share of targets that draw one below 15.3%, while the 216 shots they took would claim 1.38% only if they were independent. Review sections print no bound (n/a): a hit cannot appear among failed shots, so zero wrong hits there is true by construction. `--eval 2026-09-30` (or a round key, or a room code or other key prefix) reports the rounds from then on as a held-out set apart from the rounds the calibration was tuned on; `--since` takes the same dates (a bare date is local midnight in both), and a value it cannot read stops it with exit code 2 and the reason instead of an empty report. `--json` prints the report as data, alone on stdout (where a live pull was saved goes to stderr). It exits 1 when any wrong hit is in the log. `npm run realcheck -- shoot` prints the same kind of bounds for its real-photo shots, counted per photo.

To turn the labels into calibration changes, export the `feedback` node from the Firebase console (Realtime Database, the `feedback` node, Export JSON) or fetch it with a database secret, then:

```bash
npm run replay -- feedback.json
```

The replay (`src/feedback/replay.ts`) re-runs the evidence fusion of `src/vision/scoring.ts` from the recorded similarities under alternative face thresholds, weights and hit confidence, and prints correct / wrong / miss against the labels for each variation, scored with wrong hits weighing five misses. It first reports how often the replay under the current defaults agrees with the verdict the game actually gave, which says how far to trust the rest of the table. It applies the game's refusals on top of the belief (identity not confirmed or not re-earned, outfit veto, and the overlap/crowd rule, which re-derives each body's latest face read from the recorded similarities). Every face, the frame's own read and the body's running mean alike, is judged at the bar the game judged it at (v2 samples): `FACE_CALIB` where the player's own outfit backed the face, `FACE_ONLY_CALIB` otherwise. Whether an identity is still waiting to be confirmed, the replay works out itself on v3 samples, which record whether somebody was presumed hidden behind each body: like the tracker it sets the flag on every frame of a presumed hidden partner, an overlap or an ambiguous association and at each transition, and clears it with evidence that names the believed player (on a hiding frame only that frame's own face or outfit read), all under the replay's own parameters, so a looser face bar confirms where the game would have confirmed with it. Older samples take the flag the game recorded, which is the game's calibration's verdict. An unreadable torso records no outfit sample, as the game fuses none. Samples from builds since CALIBRATION_VERSION 2026-10-01.8 take the face similarities against the galleries the game scored with, live-learned faces included; on older samples a shot decided on a live-learned face can replay as a miss. `--eval` (as in the session report) keeps the held-out rounds out of the sweep and says how many it left out; `--json` prints only the sweep rows on stdout.

## Setup

### 1. Install

```bash
npm install
```

### 2. Firebase

The Firebase web config for the shared project is committed in `src/net/firebaseApp.ts`. It is public client configuration, the same values any player's browser downloads, and access is controlled by `database.rules.json`, so nothing needs to be configured to build or deploy.

To point a fork at your own Firebase project instead:

1. Go to https://console.firebase.google.com and create a project. Google Analytics can be off.
2. In the left menu open **Build > Realtime Database**, click **Create database**, pick a region, and start in **locked mode**.
3. Open the **Rules** tab, paste the contents of `database.rules.json`, and publish.
4. Click the gear next to **Project Overview > Project settings**, scroll to **Your apps**, click the web icon (`</>`), register an app, and copy the config values.
5. Either replace the defaults in `src/net/firebaseApp.ts`, or copy `.env.example` to `.env` and fill in the values. Environment variables override the committed defaults.

Set `VITE_LOCAL_MODE=1` to run in local mode: one device, no network, useful for testing the camera and enrollment alone.

### 2b. Google sign-in (optional, for accounts)

Signing in lets a player do the deep scan once and reuse it on any phone. Guests can still play without it.

1. In the Firebase console open **Build > Authentication**, click **Get started**, open the **Sign-in method** tab, enable **Google**, pick a support email, and save.
2. Still in Authentication, open **Settings > Authorized domains** and add the domain the game is served from, for example `your-app.vercel.app`. `localhost` is already there.
3. Re-publish `database.rules.json`. It now includes a `users` section so each account can only read and write its own scan.

Account data lives at `users/{uid}` and holds the name plus the deep scan: face embeddings and body ratios as numbers, never photos.

### 2c. Tests

```bash
npm test
```

Typechecks and runs the vision unit tests (tracking, scoring, clothing, shot timing) plus a simulated laser-tag round with Node's built-in test runner. Needs Node 22.15 or newer. The CI workflow runs them, with the strict simulation sweep, on every pull request.

The simulation (`tests/sim/`) plays whole rounds through the real shooting pipeline (`src/vision/pipeline.ts`) against a synthetic detector with distance-dependent dropouts, jitter, and face/outfit similarity levels chosen to match the phone models. Scenarios cover a close duel, back shots, 8 m, an approaching target, crossing players, look-alike and identical tops, a stranger, a mirror, a 400 ms-per-frame phone, a flaky pose model, and dim light. To see the table instead of pass/fail:

```bash
npm run sim
```

`possible` counts the shots taken while the target really was the visible person under the dot (the world keeps moving while a frame is processed, and a nearer player hides whoever is behind them), `hit` is the share of those that registered on the target, `wrong` counts shots that registered on anybody else (the outcome the game must avoid), and `tracks` is how many track ids the target went through in a run (1 means the tracker never lost them). A dot within the detector's jitter band of a nearer person's edge is judged ambiguous rather than right or wrong. The acceptance thresholds live in `tests/sim.test.ts`, which also pins seeds that once produced a wrong hit or a wrong lock.

```bash
npm run sim:full
```

Runs every scenario over 100 seeds and exits non-zero on any wrong hit or wrong-lock frame, printing the frames leading up to each one. Use it as the gate for tracking or decision changes.

```bash
npm run sim:wide
```

The wide sweep (`tests/sim/wide.ts`): the crossing and crowd scenarios over 1000 seeds (`-- --from 1001 --seeds 2000` for more), where failures too rare for the 100-seed gate hide. It lists every seed with a wrong hit or wrong-lock frame, writes `.rubric/sim-wide.json` for the rubric, and exits non-zero on anything beyond the documented residuals (`KNOWN_WIDE`). About 4 minutes, so it is not in CI; run it after any tracker, pipeline or scoring change.

Real footage (`npm run realcheck`) runs the game's own models and crops, in Chrome, on public-domain and Creative Commons photos and interview clips of real people (`npm run fixtures` downloads them from Wikimedia Commons into the git-ignored `fixtures/real/`, with attribution in `fixtures/real/SOURCES.md`): `faces` scores same-person and different-person similarity over 28 people's photos, `clips` enrols each person in an interview from its first 6 s and scores the rest against every profile, `shoot` fires at real group photos through the tracking bench and exits non-zero on any wrong hit or wrong lock. Its shots are not independent (12 per run at one static photo, with one enrolment, deterministic models and the same camera path, and two runs per photo), so it bounds the wrong-hit rate per photo first, then per run, and prints the per-shot figure only as what independent shots would give: the last run, 0 wrong in 216 shots on 9 photos, bounds the share of photos that draw a wrong hit below 28.3% (per run 15.3%), not the shot rate below 1.38%. `node --import ./tests/register.mjs scripts/compare-face-models.ts` compares candidate face models (`--face=<model>` runs, models in `fixtures/models/`). `tests/e2e/realvision.spec.ts` and `tests/e2e/practice.spec.ts` play a round and a practice session with the real models on a real clip as the camera.

### 2d. Tracking bench on a real phone

Open the game with `?bench` added to the URL, for example `https://your-app.vercel.app/?bench`. The bench scans a photo the way the lobby scans players, then points a virtual, slowly drifting camera at it and fires every 1.3 s, all through the real models and the real game pipeline, so it shows what that phone will do in a round with nobody else present:

- **period** is the time between finished frames on this phone. The stale-frame and burst allowances scale with it automatically (`src/vision/shot.ts`).
- **lock on target** is the share of frames with a green LOCK on the right name while the person is under the dot; **tracks** should stay at 1 while they are in view.
- **hits / wrong / unclear / miss / off-target** classify every automatic shot. Off-target means the drifting camera had the aim point off the person, so nothing should have happened.

Use **Sample person** for a quick check or **Photo from this phone** with a photo of the people you play with. Keep the tab in the foreground: browsers pause the camera and the vision loop in background tabs.

**Range sweep** holds a still camera at six zoom levels that shrink the person to what a phone sees at roughly 1.5, 3, 4.5, 6, 8 and 9 m, 14 s each, and tabulates per distance how often the body and face were detected, how often a face embedding actually reached the track, the mean belief, lock rate and shot outcomes. It shows where the face gives out and the outfit takes over on that phone. `?bench&auto=range` runs it hands-free (`auto=still` and `auto=drift` run the other two modes), and `window.__bench.range()` returns the rows.

The simulation (`npm run sim`) also covers crossing players, a crossing with both facing away, a nearer player walking in front of the target, and a target turning their back mid-round; these are the cases where a tracker swaps people.

### 2e. Recording a round and replaying it

Open the game with `?record` added to the URL. Every frame's detector boxes and landmarks, the face embeddings and outfit histograms the crops produced, and every FIRE are kept as numbers (never pixels). The **save rec** button in the HUD downloads them as JSON. A recording also carries every enrolled player's profile (their face signatures, outfit histograms and body ratios) so it can be replayed: those are re-identifiable numbers, so treat the file like the room itself, tell the players before recording, and never publish one. A recording stops at 3000 frames (about 10 minutes) so a long round cannot exhaust a phone's memory. Put such files in a folder and run

```bash
npm run replay:rec path/to/folder
```

to re-run each recording through the current pipeline and calibration. The table says what the game would decide today (hits by player, unclear, miss, lock frames) next to the calibration the recording was made with, so a threshold change can be compared on the same real round; `npm run replay:rec -- path/to/folder --threshold 0.6 --margin 0.25` overrides the recorded settings. Taps made with **range** on carry the target you named, and `node scripts/validate.mjs path/to/folder` judges them (see `docs/validation.md`). `tests/replay/fixtures/` holds a synthetic recording from the simulation that the tests replay.

### 3. Run on your phones over Wi-Fi

```bash
npm run dev
```

Vite prints a `https://192.168.x.x:5173` address. Open it on each phone on the same Wi-Fi and accept the self-signed certificate warning once. The camera only works over HTTPS, which is why the dev server uses one.

### 4. Deploy for free

The game is served from **Vercel**: https://lazer-shooter-game.vercel.app deploys every push to `main` automatically (Vercel detects Vite; no environment variables are needed). Share that link, or the room link the lobby offers, and players open it in their phone's browser.

To host your own copy, import the GitHub repo at https://vercel.com/new and deploy. GitHub Actions runs the merge gate (`.github/workflows/ci.yml`: tests, typecheck, build, and the strict simulation sweep) on every pull request and push to `main`.

## Playing

0. Optional: tap **Sign in with Google**, then the account row, then **Start deep scan**. About a minute, once.
1. Host taps **Create a room** and shares the link or code.
2. Everyone enrolls. Guests do 8 head angles with the selfie camera: look straight, turn slightly and then further to each side, chin up, chin down, and a smile. Turn until the hint says "Hold it" and keep still for a moment; the hint names the one thing to change (turn a bit more, turn back a little, the other way) and shows the angle the phone reads against the one it wants ("Now 7°, aim for 12°"), and left and right are whichever way you turned first, so the mirrored preview cannot trip you up. No angle can get stuck: after 6 s the best frame you managed in the right direction counts, and after 10 s **Skip this angle** appears. Only one face may be in the selfie frame (a second face pauses the samples); the scan never compares your face across angles, because the face model scores the same person turned away lower than other people facing it (`npm run realcheck -- scan`, 2026-10-01). Then a front and back body scan with the whole body in frame. The front scan keeps going until it has also learned your face from that distance (look at the phone), which is what the game sees in a round. Pick **A friend is holding it** and they tap Record with the rear camera, or **It is propped up** for a 5-second countdown with the selfie camera. Signed-in players who have done their deep scan only do the body scan, which records today's outfit.
3. Wear tops that look different from each other. The lobby will tell you if two are too close.
4. Host taps **Start game**. After a 5-second countdown, hunt.
5. Hold the phone up, put a player in the crosshair, and tap **FIRE**. The crosshair turns green with the target's name when the phone is confident.
6. A hit costs a life. After being hit you are shielded for a few seconds. Zero lives means you spectate.
7. The round ends when one player is left standing (or when every other survivor's phone has dropped off for a while). If the host's phone drops for ten seconds, the earliest-joined connected player becomes host and can start the next round. Up to twelve players get distinct colours.

## Tips for reliable hits

- Good light matters more than anything. Face recognition needs the face to be at least the size of a thumbnail on screen.
- The clothing signature carries hits from behind and at range. Bright, solid, distinct tops work best. Avoid tops that match the walls.
- Tap **debug** during a game to see boxes, names, and confidence live. Handy for tuning **Hit confidence** in the lobby.
- Face similarity is the cosine of **mean-centred** embeddings (`centredSimilarity` in `src/vision/embedding.ts`). Every embedding the model produces shares one direction (the mean vector in `src/vision/faceMean.ts`, length 0.43), so raw cosine overstates how alike two strangers are; after subtracting the mean, different people sit at a median of 0 with a 90th percentile of 0.17. The face model is InsightFace GhostNet (strides 1) since 2026-09-26: on real footage (`npm run realcheck`, below) it kept one person's same-session frames at 0.49 or more (5th percentile) against their scan where the previous MobileNet-Swish model fell to 0.25, and separated a person from the other person in the same room by 0.26 at the 5th percentile against 0.14; `node --import ./tests/register.mjs scripts/compare-face-models.ts` reruns that comparison. It also judges each model at the game's operating point: the share of same-session frames and running track means accepted at the strictest cutoff with zero false accepts against unenrolled faces and the other enrolled people, and at cutoffs equivalent to `FACE_CALIB` and `FACE_ONLY_CALIB`, with the time of one zoom crop per model. Rechecked on 2026-10-01 with 6 talkers, GhostNet stayed: it ties EfficientNet-B0 on track means (91% and 90% at zero false accepts) and leads on outfit-corroborated faces (see `TRACKING_IMPROVEMENT_PLAN.md`). `FACE_CALIB` (`reject` 0.30, `accept` 0.62) is set against those numbers (see `calibration.ts`). Every threshold the shooting decision depends on lives in `src/vision/calibration.ts` under one `CALIBRATION_VERSION`, and each shot log entry records that version, so a log from an older build is never compared against today's numbers. Faces under 34 px are ignored and faces under 56 px count with reduced weight. Scans taken with the old model are refused as out of date and must be repeated. If real rounds refuse good shots, compare the similarities in the shot log with these numbers before moving the thresholds.
- Real faces are less clean than those numbers suggest. `npm run realcheck` (below) runs the models on real photos and clips: different people reached 0.66 to 0.75 (visually confirmed pairs), above `accept`, and one person's live frames scored 0.30 at the 5th percentile against their own scan (0.35 for the track's running mean). A face alone therefore cannot be allowed to name somebody whose clothes say otherwise: players play in the outfit they scanned, so a clothing sample covering at least the top that contradicts a player's scanned outfit (`OUTFIT_VETO`) rules that player out on that body, whatever the face says, until a clear sample (similarity 0.6 over 70 % of the outfit) clears it; a sample that only partly agrees starts a 4 s countdown instead. A veto that lapsed on a clock alone let a look-alike be hit 42 times in 40 seeds on a slow phone, whose clothing samples come about 1.8 s apart. The lock label and the hit both respect it; a player who changed clothes gets UNCLEAR TARGET, never a wrong hit. A body cannot change clothes between two reads either: when a sample clearly matches a player that this track's own earlier reads ruled out, the track has moved onto somebody else's body, so its identity starts over, and a shot still waiting for frames that had no accepted name at the tap can no longer land on that track, even once the new body is recognised (the `crossing-lookalike-faces` simulation, seed 63, 2026-10-01). The `lookalike-stranger` simulation (a non-player at 0.66 face similarity in other clothes) went from 34 wrong hits in 30 seeds to none. A candidate with no outfit on file at all (a practice target captured without the hips in view) cannot be protected that way, so their face must clear a stricter bar (`FACE_ONLY_CALIB`, 0.60/0.95), and so must any player whose own outfit has not backed the face on that body in the last 3 s. A look-alike stranger went from 35 wrong hits in 30 seeds to none in 100; the cost is real: a face-only target is almost never hit (1 % of shots in the sim) and a player whose torso cannot be read lands 17 % of shots. Face alone cannot tell a look-alike apart, so practice capture asks for the hips in view and the outfit scan matters.
- `npm run realcheck` needs the real-person fixtures once: `npm run fixtures` downloads public-domain and Creative Commons photos and clips from Wikimedia Commons into `fixtures/real/` (git-ignored, attribution in `fixtures/real/SOURCES.md`).
- During a round the shooter's phone adds strong, unambiguous face matches (centred similarity above about 0.53 on a sharp face, with no other player close) to that player's gallery for the rest of the round, so recognition adapts to the venue's light and distances. The lobby warns when two players' scans read alike to the model; hits between them then lean on outfits.
- Enrolment stores the 8 close selfie angles plus up to 6 face samples taken during the body scan, when the phone is metres away like an opponent's, which is what a round actually sees.
- A shot taken while the newest frame is older than the allowance in `src/vision/shot.ts` (which grows with the measured frame period up to a ceiling) is not refused: it opens a burst that must see the same person under the dot in a frame captured after the tap. Only a frame older than three times the allowance says CAMERA TOO SLOW; the shot log records the frame age and the allowance of each refused shot, and the bench (`?bench`) shows the phone's frame period directly.
- **Range test**: with debug on, tap **range**, pick who you are aiming at (or "Not a player"), the distance and the set-up chips, then fire. Shots deal no damage, are logged with that answer, and keep their photo on the phone for **Practice review** (at most six hours, as in practice). Right or wrong is decided by player id, so two players with the same name cannot pass a wrong lock off as right. The table counts correct, wrong-player, and missed decisions per distance, so a change to thresholds can be compared on the same set of people.

## Stack

Vite + React + TypeScript, `@vladmandic/human` (BlazeFace + FaceMesh + InsightFace GhostNet embeddings + MoveNet MultiPose), Firebase Realtime Database, Web Audio for synthesized sounds, `vite-plugin-pwa`.
