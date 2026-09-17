---
description: Run the Lazer Shooter AI workflow (Boris + Karpathy + gstack) stage by stage
argument-hint: [stage number to start from, default 1]
---
Run the stages below in order, starting at stage $ARGUMENTS (default 1). Stop and wait for me only at the lines marked CHECKPOINT. Everything else, just do.

## Stage 1 — project memory (Boris)
- If CLAUDE.md does not exist, create it (use /init). It must list the verification commands: `npm test`, `npm run typecheck`, `npm run sim -- --seeds 100`, and `npm run build`. Add a LESSONS section with this first rule: "Raising hit confidence or extending tracking timeouts alone is not a fix; find the identity/aim root cause."
- The working tree has uncommitted changes. Show me `git status --short` and a one-paragraph summary of what they are. CHECKPOINT: ask whether to commit them as-is, stash them, or leave them.

## Stage 2 — wiki (Karpathy)
- Copy README.md and TRACKING_IMPROVEMENT_PLAN.md into ~/Documents/knowledge-base/raw/ as lazer-shooter-readme.md and lazer-shooter-tracking-plan.md.
- Run /wiki ingest on each. Do not pause for the takeaway discussion; write the takeaways into the log entry instead.

## Stage 3 — investigate and lock the plan (gstack)
- Run /investigate on: occlusion seed 60 resolves FIRE to Bob at 9300 ms while the aim is on Alice; stranger seed 23 produces a false player-lock frame. Write findings to a new section at the top of TRACKING_IMPROVEMENT_PLAN.md.
- Run /plan-eng-review on TRACKING_IMPROVEMENT_PLAN.md. CHECKPOINT: show me the locked plan and test matrix; wait for approval.

## Stage 4 — unattended implementation (autopilot)
- Run /goal with: "In ~/Documents/GitHub/LazerShooterGame, implement TRACKING_IMPROVEMENT_PLAN.md section by section. Done means npm test, npm run typecheck, and npm run sim -- --seeds 100 all pass with zero wrong hits and zero wrong locks, and occlusion seed 60 and stranger seed 23 are permanent regression tests."
- That starts the loop. Tell me it is running and stop here; stages 5 and 6 run after the loop reports the backlog empty.

## Stage 5 — gates (gstack)
- /review, fix what it finds, re-verify.
- /cso, focused on database.rules.json and the public Firebase config. CHECKPOINT: show findings before changing rules.
- Start the dev server with `npm run dev:http` in the background, then /qa http://localhost:5173 on lobby, enrollment, and results. Skip camera-dependent flows.

## Stage 6 — ship
- /ship. CHECKPOINT: show the PR before it is opened. Never push to main directly.

Rules for the whole run: no force-push, no reset --hard, no deleting branches, no edits under node_modules or dist.
