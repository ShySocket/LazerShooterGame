#!/usr/bin/env bash
# Undo a commit without rewriting history, then push so Vercel redeploys the older behaviour.
#
#   scripts/rollback.sh              revert the most recent commit
#   scripts/rollback.sh <commit>...  revert one or more specific commits (newest first)
#   scripts/rollback.sh --list       just show recent commits
#
# Each revert becomes a new commit, so nothing is lost: run the script again on the
# revert commit to bring the change back.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--list" ]]; then
  git log --oneline -15
  exit 0
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "You have uncommitted changes. Commit or stash them first so the rollback is clean."
  exit 1
fi

targets=("${@:-HEAD}")
echo "Recent commits:"
git log --oneline -8
echo
echo "About to revert:"
for t in "${targets[@]}"; do git log --oneline -1 "$t"; done
echo
read -r -p "Continue? [y/N] " ans
[[ "$ans" == [yY] ]] || { echo "Cancelled."; exit 1; }

git revert --no-edit "${targets[@]}"
git push
echo
echo "Reverted and pushed. Vercel will redeploy in a minute or two."
