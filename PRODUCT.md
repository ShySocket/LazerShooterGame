# Product: Lazer Shooter

Real-life laser tag played with phones. A group of friends opens one link, each player scans their face and outfit, and then they hunt each other through the rear camera: aim the reticle at a player, tap FIRE, and the phone decides on-device whether that player was hit. Last player alive wins.

## Who and where
- Groups of 2 to 8 friends at a party, a park, a campus or a house. Most of them are first-timers who opened a shared link a minute ago.
- The phone is held at arm's length, often while running, in bright sun or in a dim room. Glances last half a second, so the HUD must read at a glance in both.
- The host is the person who shared the link. They set the rules and start the round while everyone else waits.

## What success looks like
- From link to first shot in under two minutes, without anyone explaining the app.
- Every shot gives an unmistakable answer (HIT, MISS or the reason it could not decide) and names what to do next.
- Landing a hit and winning feel like the best moments of the evening. Being out is not a dead end.

## Product truths the UI must keep
- No photos leave the phone; only numeric signatures are shared. The scan explains itself in one line.
- A shot that cannot tell targets apart is refused, not guessed. Refusals are part of the game and are worded as advice (`src/ui/advice.ts`).
- Works offline-ish: the app is a PWA, and fonts and assets must be self-hosted.

## Surfaces
- Home, join, enrol (face and outfit scan), lobby, game HUD, spectator, results, profile, practice.
- Mode: Operate for menus, Experience for the game camera.
