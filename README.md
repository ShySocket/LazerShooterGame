# Lazer Shooter

Real-life laser tag played with phones. Everyone opens the same link, enrolls their face and outfit, and then hunts each other with the rear camera. Press FIRE while another player is in the crosshair and their phone takes the hit.

- **Mobile web app (PWA)**: no app store. iPhone and Android both work in the browser.
- **Free multiplayer**: Firebase Realtime Database free tier syncs rooms, lives, and hits. Optional Google sign-in stores a one-time scan per account.
- **On-device vision**: face recognition, body pose, and clothing colour all run on the shooter's phone. Only numeric signatures are shared, never photos.
- **Rules**: 3 lives, no respawn, last player standing wins. Cooldown and shield times are tunable in the lobby.

## How a hit is decided

Each body the camera sees gets a running belief of who it is, built from four signals:

1. **Face recognition** with an InsightFace (ArcFace-family) model against the 8 head angles captured at enrollment. Strongest signal, only works within ~3 m and within about 45° of face-on. Cosine similarity, thresholds in `src/vision/human.ts`.
2. **Identity tracking**: once a body is recognised it stays recognised while it remains in frame, even when it turns around.
3. **Outfit signature**: colour histograms of the top, thighs, shins, and hair, captured front and back at enrollment. This is what makes back-shots and long-range shots work. The lobby refuses to start if two players' whole outfits look too alike.
4. **Body proportions**: shoulder, hip, leg, and head ratios from the pose model. A weak tiebreaker that survives a change of clothes.

Two decoys compete with the real players: the shooter's own profile, so a mirror or a look-alike resolves to YOU, and a stranger baseline that wins whenever nobody matches well. A shot only counts when a live opponent is above the hit confidence and clearly ahead of everyone else, decoys included. Otherwise the app says UNCLEAR TARGET, THAT IS YOU, or NOT A PLAYER instead of guessing.

After a round, **Show my shot log** on the results screen lists every FIRE press with the top beliefs at that moment. Use it to see why a shot landed or did not.

## Setup

### 1. Install

```bash
npm install
```

### 2. Firebase (free, needed for multiplayer)

1. Go to https://console.firebase.google.com and create a project. Google Analytics can be off.
2. In the left menu open **Build > Realtime Database**, click **Create database**, pick a region, and start in **locked mode**.
3. Open the **Rules** tab, paste the contents of `database.rules.json`, and publish. These rules let anyone who knows a 4-letter room code read and write that room, which is fine for playing with friends.
4. Click the gear next to **Project Overview > Project settings**, scroll to **Your apps**, click the web icon (`</>`), register an app (no hosting needed), and copy the config values.
5. Copy `.env.example` to `.env` and fill in the values. `VITE_FIREBASE_DATABASE_URL` is the `databaseURL` field.

Without a `.env` the app runs in local mode: one device, no multiplayer, useful for testing the camera and enrollment.

### 2b. Google sign-in (optional, for accounts)

Signing in lets a player do the deep scan once and reuse it on any phone. Guests can still play without it.

1. In the Firebase console open **Build > Authentication**, click **Get started**, open the **Sign-in method** tab, enable **Google**, pick a support email, and save.
2. Still in Authentication, open **Settings > Authorized domains** and add the domain the game is served from, for example `your-app.vercel.app`. `localhost` is already there.
3. Re-publish `database.rules.json`. It now includes a `users` section so each account can only read and write its own scan.

Account data lives at `users/{uid}` and holds the name plus the deep scan: face embeddings and body ratios as numbers, never photos.

### 3. Run on your phones over Wi-Fi

```bash
npm run dev
```

Vite prints a `https://192.168.x.x:5173` address. Open it on each phone on the same Wi-Fi and accept the self-signed certificate warning once. The camera only works over HTTPS, which is why the dev server uses one.

### 4. Deploy for free

**Vercel**: import the GitHub repo at https://vercel.com/new, add the five `VITE_FIREBASE_*` values under Environment Variables, deploy. Vercel detects Vite automatically.

**GitHub Pages**: in the repo go to **Settings > Pages** and set Source to **GitHub Actions**. Then add the five `VITE_FIREBASE_*` values under **Settings > Secrets and variables > Actions**. Every push to `main` deploys via `.github/workflows/pages.yml`.

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
- If close-range faces are confused or never lock, adjust `FACE_CALIB` in `src/vision/human.ts` using the similarity numbers from the shot log.

## Stack

Vite + React + TypeScript, `@vladmandic/human` (BlazeFace + FaceMesh + InsightFace MobileNet-Swish embeddings + MoveNet MultiPose), Firebase Realtime Database, Web Audio for synthesized sounds, `vite-plugin-pwa`.
