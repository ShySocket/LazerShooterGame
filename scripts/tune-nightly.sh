#!/usr/bin/env bash
# One night of the calibration tuning loop (docs/tuning-loop.md), as .github/workflows/tune.yml runs it:
# npm run tune; on a proposal npm run tune:gate; when the gate is green, commit the calibration to a
# fresh tune/<date>-<run> branch, open a pull request (never merged here), close the previous open
# tuning PR as superseded, and start CI on the new branch (a PR opened with the workflow's token does
# not trigger CI by itself). Writes the report to $GITHUB_STEP_SUMMARY when it is set.
#
# Env: FIREBASE_SA_KEY (unset: the night is skipped and says so), TUNE_FILE (tune a saved export
# instead of the live log), DRY_RUN=1 (print the git/gh commands instead of running them, for a local
# rehearsal), TUNE_OUT (default .rubric/tune), RUN_ID (branch suffix, default the time).
# A gate that fails only on unit tests (exit 3: replay and simulation sweeps green) opens a draft PR
# titled "[tests need updating]" for a person to judge; any other failure opens nothing.
# Exit: 0 nothing to do or PR opened; 1 the gate failed (no PR); 2 tune could not run.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT="${TUNE_OUT:-.rubric/tune}"
DAY="$(date -u +%Y-%m-%d)"
BRANCH="tune/${DAY}-${RUN_ID:-$(date -u +%H%M%S)}"
LABEL="calibration-tuning"
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat >> "$GITHUB_STEP_SUMMARY"; else cat; fi; }
act() { if [ "${DRY_RUN:-}" = "1" ]; then echo "[dry-run] $*"; else "$@"; fi; }

if [ -z "${TUNE_FILE:-}" ] && [ -z "${FIREBASE_SA_KEY:-}" ]; then
  echo "No FIREBASE_SA_KEY secret: the feedback log cannot be read, nothing tuned. See docs/tuning-loop.md (one-time setup)." | summary
  exit 0
fi

args=(--out "$OUT" --day "$DAY")
[ -n "${TUNE_FILE:-}" ] && args+=(--file "$TUNE_FILE")
npm run -s tune -- "${args[@]}"
code=$?
if [ "$code" -eq 0 ]; then
  summary < "$OUT/pr-body.md"
  exit 0
elif [ "$code" -ne 10 ]; then
  echo "npm run tune failed with exit code $code." | summary
  exit 2
fi

npm run -s tune:gate -- --out "$OUT"
gate=$?
summary < "$OUT/pr-body.md"
draft=()
title="$(cat "$OUT/pr-title.txt")"
if [ "$gate" -eq 3 ]; then
  draft=(--draft)
  title="[tests need updating] ${title}"
elif [ "$gate" -ne 0 ]; then
  echo "The gate failed: no pull request. The proposal and its evidence are above." >&2
  exit 1
fi

act git config user.name "lazer-tuning-bot"
act git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
act git switch -c "$BRANCH"
act git add src/vision/calibration.ts README.md
act git commit -m "$title" -m "Nightly calibration tuning from labelled shot feedback; evidence and gate results in the pull request."
act git push -u origin "$BRANCH"
act gh label create "$LABEL" --color 5319e7 --description "Nightly calibration proposal from shot feedback" --force
previous="$(gh pr list --label "$LABEL" --state open --json number --jq '.[].number' 2>/dev/null || true)"
url="$(act gh pr create --base main --head "$BRANCH" --title "$title" --body-file "$OUT/pr-body.md" --label "$LABEL" ${draft[@]+"${draft[@]}"})"
echo "opened: $url"
for n in $previous; do
  act gh pr close "$n" --delete-branch --comment "Superseded by ${url}: the nightly tuning reran on newer feedback."
done
act gh workflow run ci.yml --ref "$BRANCH"
echo "Pull request: ${url}" | summary
exit 0
