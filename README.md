# Lazer Shooter

Real-life laser tag played with phones. Everyone opens the same link, enrolls their face and outfit, and then hunts each other with the rear camera. Press FIRE while another player is in the crosshair and their phone takes the hit.

- **Mobile web app (PWA)**: no app store. iPhone and Android both work in the browser.
- **Free multiplayer**: Firebase Realtime Database free tier syncs rooms, lives, and hits. Optional Google sign-in stores a one-time scan per account.
- **On-device vision**: face recognition, body pose, and clothing colour all run on the shooter's phone. Only numeric signatures are shared, never photos, including in the shot review after a round.
- **Rules**: 3 lives, no respawn, last player standing wins. Cooldown and shield times are tunable in the lobby.

## How a hit is decided

Each body the camera sees gets a running belief of who it is, built from four signals:

1. **Face recognition** with an InsightFace (ArcFace-family) model against the 8 head angles captured at enrollment. Strongest signal, only works within ~3 m and within about 45° of face-on. Cosine similarity, thresholds in `src/vision/embedding.ts`.
2. **Identity tracking**: once a body is recognised it stays recognised while it remains in frame, even when it turns around.
3. **Outfit signature**: colour histograms of the top, thighs, shins, and hair, captured front and back at enrollment. This is what makes back-shots and long-range shots work. The lobby refuses to start if two players' whole outfits look too alike.
4. **Body proportions**: shoulder, hip, leg, and head ratios from the pose model. A weak tiebreaker that survives a change of clothes.

Two decoys compete with the real players: the shooter's own profile, so a mirror or a look-alike resolves to YOU, and a stranger baseline that wins whenever nobody matches well. A shot only counts when a live opponent is above the hit confidence and clearly ahead of everyone else, decoys included. Otherwise the app says UNCLEAR TARGET, THAT IS YOU, or NOT A PLAYER instead of guessing.

After a round, **Show my shot log** on the results screen lists every FIRE press with the top beliefs at that moment. Use it to see why a shot landed or did not.

## Shot review after a round

When the round ends, each player's results screen shows one of their own failed shots (a MISS, UNCLEAR TARGET or CAMERA TOO SLOW) as the camera frame from the moment they fired, with the crosshair drawn on it, and asks: **Did you clearly shoot another player when you did this shot?** The answers are "Yes, I shot <name>", "No, this should not count", "I can't tell from this photo" and Skip. Shots where a body was under the dot are preferred, and "Review another shot" offers the rest. The card stays through the host's Back to lobby.

- **The photo never leaves the phone.** It is kept in the browser's IndexedDB only until the answer, skip or the next round, then deleted.
- **What is uploaded** is the deconstruction of the shot: for the last 12 frames before the tap and every frame of the burst after it, each body's belief, the raw face similarity of that frame's embedding and of the track's running mean against every player, the outfit match (similarity, coverage, trousers seen) and body-ratio similarity per player, plus the target's face mean, outfit signature and ratios, the room settings, frame period, model names, app commit, and the label. Player ids are replaced by `p0`, `p1`, ... (sorted order of the round's enrolled ids) and names are not included. The round's profiles (the same numeric signatures the room already shares) are written once per round next to the samples so they can be re-scored.
- "I can't tell" and Skip upload nothing. An upload that fails (no signal at the venue) waits on the phone and goes out the next time a results or lobby screen opens.
- Storage: `feedback/rounds/{CODE-startAt}/{profiles,samples}` in the Realtime Database, write-once and not readable by clients (`database.rules.json`). Local mode keeps samples in memory instead.

To turn the labels into calibration changes, export the `feedback` node from the Firebase console (Realtime Database, the `feedback` node, Export JSON) or fetch it with a database secret, then:

```bash
npm run replay -- feedback.json
```

The replay (`src/feedback/replay.ts`) re-runs the evidence fusion of `src/vision/scoring.ts` from the recorded similarities under alternative face thresholds, weights and hit confidence, and prints correct / wrong / miss against the labels for each variation, scored with wrong hits weighing five misses. It first reports how often the replay under the current defaults agrees with the verdict the game actually gave, which says how far to trust the rest of the table. Live face samples learned during the round are not part of the replay's galleries, so a shot that was decided on them can replay as a miss.

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

Typechecks and runs the vision unit tests (tracking, scoring, clothing, shot timing) plus a simulated laser-tag round with Node's built-in test runner. Needs Node 22.15 or newer. The Pages workflow runs them before every deploy.

The simulation (`tests/sim/`) plays whole rounds through the real shooting pipeline (`src/vision/pipeline.ts`) against a synthetic detector with distance-dependent dropouts, jitter, and face/outfit similarity levels chosen to match the phone models. Scenarios cover a close duel, back shots, 8 m, an approaching target, crossing players, look-alike and identical tops, a stranger, a mirror, a 400 ms-per-frame phone, a flaky pose model, and dim light. To see the table instead of pass/fail:

```bash
npm run sim
```

`hit` is the share of shots that registered on the aimed player, `wrong` counts shots that registered on anybody else (the outcome the game must avoid), and `tracks` is how many track ids the target went through in a run (1 means the tracker never lost them). The acceptance thresholds live in `tests/sim.test.ts`.

### 2d. Tracking bench on a real phone

Open the game with `?bench` added to the URL, for example `https://your-app.vercel.app/?bench`. The bench scans a photo the way the lobby scans players, then points a virtual, slowly drifting camera at it and fires every 1.3 s, all through the real models and the real game pipeline, so it shows what that phone will do in a round with nobody else present:

- **period** is the time between finished frames on this phone. The stale-frame and burst allowances scale with it automatically (`src/vision/shot.ts`).
- **lock on target** is the share of frames with a green LOCK on the right name while the person is under the dot; **tracks** should stay at 1 while they are in view.
- **hits / wrong / unclear / miss / off-target** classify every automatic shot. Off-target means the drifting camera had the aim point off the person, so nothing should have happened.

Use **Sample person** for a quick check or **Photo from this phone** with a photo of the people you play with. Keep the tab in the foreground: browsers pause the camera and the vision loop in background tabs.

### 3. Run on your phones over Wi-Fi

```bash
npm run dev
```

Vite prints a `https://192.168.x.x:5173` address. Open it on each phone on the same Wi-Fi and accept the self-signed certificate warning once. The camera only works over HTTPS, which is why the dev server uses one.

### 4. Deploy for free

**Vercel**: import the GitHub repo at https://vercel.com/new and deploy. Vercel detects Vite automatically and no environment variables are needed.

**GitHub Pages**: in the repo go to **Settings > Pages** and set Source to **GitHub Actions**. Every push to `main` deploys via `.github/workflows/pages.yml`.

## Playing

0. Optional: tap **Sign in with Google**, then the account row, then **Start deep scan**. About a minute, once.
1. Host taps **Create a room** and shares the link or code.
2. Everyone enrolls. Guests do 8 head angles with the selfie camera, then a front and back body scan with the whole body in frame. Pick **A friend is holding it** and they tap Record with the rear camera, or **It is propped up** for a 5-second countdown with the selfie camera. Signed-in players who have done their deep scan only do the body scan, which records today's outfit.
3. Wear tops that look different from each other. The lobby will tell you if two are too close.
4. Host taps **Start game**. After a 5-second countdown, hunt.
5. Hold the phone up, put a player in the crosshair, and tap **FIRE**. The crosshair turns green with the target's name when the phone is confident.
6. A hit costs a life. After being hit you are shielded for a few seconds. Zero lives means you spectate.

## Tips for reliable hits

- Good light matters more than anything. Face recognition needs the face to be at least the size of a thumbnail on screen.
- The clothing signature carries hits from behind and at range. Bright, solid, distinct tops work best. Avoid tops that match the walls.
- Tap **debug** during a game to see boxes, names, and confidence live. Handy for tuning **Hit confidence** in the lobby.
- `FACE_CALIB` in `src/vision/embedding.ts` was calibrated on real photos through the same square-crop pipeline the game uses: impostor pairs sit at a median of 0.12 cosine similarity with a 90th percentile of 0.27, the same person across photos at a median of about 0.49. `reject` is the impostor 90th percentile, `accept` a solid genuine match. Faces under 34 px are ignored and faces under 56 px count with reduced weight, because blur alone removes about 30% of a match. If real rounds still refuse good shots, compare the similarities in the shot log with these numbers before moving the thresholds.
- Enrolment stores the 8 close selfie angles plus up to 6 face samples taken during the body scan, when the phone is metres away like an opponent's, which is what a round actually sees.
- If shots keep saying CAMERA TOO SLOW, the phone's frames are older than the allowance in `src/vision/shot.ts`, which already grows with the measured frame period up to a ceiling. The shot log records the frame age and the allowance of each refused shot; run the bench (`?bench`) to see the phone's frame period directly.
- **Range test**: with debug on, tap **range**, pick who you are aiming at (or "Not a player") and the distance, then fire. Shots deal no damage. The table counts correct, wrong-player, and missed decisions per distance, so a change to thresholds can be compared on the same set of people.

## Stack

Vite + React + TypeScript, `@vladmandic/human` (BlazeFace + FaceMesh + InsightFace MobileNet-Swish embeddings + MoveNet MultiPose), Firebase Realtime Database, Web Audio for synthesized sounds, `vite-plugin-pwa`.
