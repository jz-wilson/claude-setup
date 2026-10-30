#!/usr/bin/env bash
# Two-way vault sync for a scheduler (every 5 minutes). Save as scripts/vault-sync.sh.
#   scripts/vault-sync.sh <vault-dir>      env: REMOTE (default origin), BRANCH (default main), SETTLE_MINUTES (default 10)
# 1. Commit files nobody has touched for SETTLE_MINUTES, so half-written notes stay out.
#    If the pre-commit hook rejects an agent log, the other files are still committed.
# 2. Merge the remote (a merge, never a rebase). On a conflict, abort and exit 1 with the tree clean.
# 3. Push.
set -euo pipefail
cd "${1:?usage: vault-sync.sh <vault-dir>}"
# Schedulers start with a minimal PATH; the pre-commit hook needs bun.
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
remote=${REMOTE:-origin} branch=${BRANCH:-main} settle=${SETTLE_MINUTES:-10}
stamp() { date +%Y-%m-%dT%H:%M:%S; }
commit() { git commit -q -m "sync: $(hostname) $(stamp)"; }

git ls-files -m -o --exclude-standard -z | while IFS= read -r -d '' f; do
  if [ ! -e "$f" ]; then
    git rm -q --cached -- "$f"
  elif [ -n "$(find "./$f" -maxdepth 0 -mmin +"$settle")" ]; then
    git add -- "$f"
  fi
done
if ! git diff --cached --quiet; then
  if ! commit; then
    echo "$(stamp) snapshot rejected; committing without agent logs" >&2
    git reset -q -- agents
    if ! git diff --cached --quiet && ! commit; then
      echo "$(stamp) snapshot commit failed; nothing committed" >&2
      git reset -q
    fi
  fi
fi

git fetch -q "$remote"
if git rev-parse -q --verify "$remote/$branch" >/dev/null; then
  if ! git merge -q --no-edit "$remote/$branch"; then
    if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
      git merge --abort
      echo "$(stamp) CONFLICT merging $remote/$branch; resolve by hand" >&2
      exit 1
    fi
    # The merge never started: it would overwrite a local edit that has not settled yet.
    echo "$(stamp) DEFER: unsettled local edits block the merge; next run retries" >&2
    exit 0
  fi
fi
git push -q "$remote" "HEAD:$branch"
echo "$(stamp) ok"
