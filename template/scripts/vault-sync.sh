#!/usr/bin/env bash
# Two-way vault sync for a scheduler (every 5 minutes). Save as scripts/vault-sync.sh.
#   scripts/vault-sync.sh <vault-dir>      env: REMOTE (default origin), BRANCH (default main), SETTLE_MINUTES (default 10)
# 1. Commit files nobody has touched for SETTLE_MINUTES, so half-written notes stay out.
# 2. Merge the remote (a merge, never a rebase); on a conflict, abort and exit 1 with the tree clean.
# 3. Push.
set -euo pipefail
cd "${1:?usage: vault-sync.sh <vault-dir>}"
remote=${REMOTE:-origin} branch=${BRANCH:-main} settle=${SETTLE_MINUTES:-10}
stamp() { date +%Y-%m-%dT%H:%M:%S; }

git ls-files -m -o --exclude-standard -z | while IFS= read -r -d '' f; do
  if [ ! -e "$f" ]; then
    git rm -q --cached -- "$f"
  elif [ -n "$(find "$f" -maxdepth 0 -mmin +"$settle")" ]; then
    git add -- "$f"
  fi
done
if ! git diff --cached --quiet; then
  # The pre-commit hook still runs; a failing log is left uncommitted for the agent or you to fix.
  git commit -q -m "sync: $(hostname) $(stamp)" || { echo "$(stamp) snapshot rejected by pre-commit" >&2; git reset -q; }
fi

git fetch -q "$remote"
if git rev-parse -q --verify "$remote/$branch" >/dev/null; then
  if ! git merge -q --no-edit "$remote/$branch"; then
    git merge --abort
    echo "$(stamp) CONFLICT merging $remote/$branch; resolve by hand" >&2
    exit 1
  fi
fi
git push -q "$remote" "HEAD:$branch"
echo "$(stamp) ok"
