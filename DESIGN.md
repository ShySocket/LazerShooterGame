# Design: Tactical HUD

A dark, high-contrast heads-up display for a game played through a camera. The camera is the hero; everything drawn over it must survive sunlight. The menu screens share the same language so the app feels like one device.

## Tokens (src/styles.css `:root`)
- **Colour:** near-black navy ground (`--bg`, `--surface`, `--surface-2`), cool hairlines (`--line`, `--line-strong`), off-white text (`--text`) and a 4.5:1 muted grey (`--muted`). There is one signal red (`--signal`) for actions, hits and the brand, and one lock green (`--lock`) used only for "on target", "ready" and success. Amber (`--warn`) marks advice and caution. There are no other hues; player colours come from the game.
- **Type:** Chakra Petch (squared, technical) for the display voice: wordmark, titles, buttons, banners, the countdown. JetBrains Mono for measurements only: room codes, counts, timers, settings values, lives. System sans for running text. Scale: 12 / 14 / 16 / 18 / 22 / 28 / 40 / 64 / 140.
- **Shape:** 6 px radius on panels, inputs and buttons. Filled actions (primary button, FIRE plate, banners) carry a 10 px chamfer on two opposite corners, which is the one signature shape. Pills are reserved for HUD status chips.
- **Space:** 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48.
- **Depth:** no glows. HUD elements sit on opaque dark plates (`--plate`) with a 1 px line so they read over any camera frame.
- **Motion:** ease-out `cubic-bezier(0.23, 1, 0.32, 1)`; press 120 ms, UI 180 ms, beat 280 ms. Only transform and opacity. `prefers-reduced-motion` reduces everything to short fades.
- **Layers:** camera 0, debug overlay 1, reticle 2, flash 3, HUD 4, banners 5, countdown 6.

## Rules
- One primary action per screen, filled signal red. Secondary actions are outlined; tertiary actions are quiet text buttons at least 44 px tall.
- No eyebrow labels above headings, no emoji or unicode glyphs as icons (lives are drawn), and no gradient text.
- Every player-facing sentence comes from `src/ui/advice.ts` or the screen itself, in plain words; units like ms never reach the player.
