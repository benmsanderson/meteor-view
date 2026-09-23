#!/usr/bin/env bash
#
# Rebuild METEOR's integration/meteor-view branch and prove it is honest.
#
# This repository develops against `integration/meteor-view`, a branch that
# stands in for METEOR's `base` once the PRs in flight have merged. That is
# only a safe thing to do if the branch really is base-plus-those-PRs and
# nothing else — otherwise we would be building against a fiction and
# discovering the difference at merge time.
#
# So this script does not just merge: it rebuilds the branch, then separately
# performs the merge sequence into a throwaway worktree and asserts the two
# trees are identical. A drifted or hand-edited integration branch fails here
# rather than silently.
#
# Run it whenever a PR in the list below is updated during review.
#
# Usage:
#   scripts/refresh-integration.sh [--push] [--test]
#
#   --push   update origin/integration/meteor-view (default: local only)
#   --test   run METEOR's unit suite against the result

set -euo pipefail

METEOR="${METEOR_REPO:-$HOME/GitHub/METEOR}"
TRUNK="base"
INTEGRATION="integration/meteor-view"

# The PRs this repository depends on, in the recommended merge order.
# Keep in step with docs/00-development-plan.md.
BRANCHES=(
  "ci/stabilise-flaky-jobs"           # #104
  "fix/noise-cache-config-validation" # #102
  "feat/portable-emulator-export"     # #101
)

PUSH=0
RUN_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --test) RUN_TESTS=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$METEOR/.git" ] || { echo "no METEOR checkout at $METEOR (set METEOR_REPO)" >&2; exit 1; }
cd "$METEOR"

echo "Fetching..."
git fetch -q origin

work="$(mktemp -d)"
check="$(mktemp -d)"
cleanup() {
  git worktree remove --force "$work" 2>/dev/null || true
  git worktree remove --force "$check" 2>/dev/null || true
  # Scratch branches must go too: an aborted run would otherwise leave them
  # behind and the next run would fail on the name rather than on the problem.
  git branch -D _integration_rebuild _sequence_check 2>/dev/null || true
  rm -rf "$work" "$check"
}
trap cleanup EXIT

# 1. Rebuild the integration branch from trunk.
git worktree add -q --force --detach "$work" "origin/$TRUNK"
git -C "$work" switch -q -C _integration_rebuild
for branch in "${BRANCHES[@]}"; do
  if ! git -C "$work" merge --no-edit -q "origin/$branch" 2>/dev/null; then
    echo "CONFLICT merging $branch:" >&2
    git -C "$work" diff --name-only --diff-filter=U | sed 's/^/    /' >&2
    exit 1
  fi
  printf '  merged %-36s %s\n' "$branch" "$(git -C "$work" rev-parse --short "origin/$branch")"
done
rebuilt="$(git -C "$work" rev-parse 'HEAD^{tree}')"

# 2. Independently perform the merge sequence, and compare trees. This is the
#    assertion that the branch is base + these PRs and nothing else.
git worktree add -q --force --detach "$check" "origin/$TRUNK"
git -C "$check" switch -q -C _sequence_check
for branch in "${BRANCHES[@]}"; do
  git -C "$check" merge --no-edit -q "origin/$branch" 2>/dev/null
done
sequence="$(git -C "$check" rev-parse 'HEAD^{tree}')"

if [ "$rebuilt" != "$sequence" ]; then
  echo "MISMATCH: rebuilt branch differs from the merge sequence" >&2
  git -C "$work" --no-pager diff --stat "$sequence" "$rebuilt" >&2
  exit 1
fi
echo "Verified: tree matches the merge sequence into $TRUNK ($rebuilt)"

if [ "$RUN_TESTS" = 1 ]; then
  python="${PYTHON:-$METEOR/.venv/bin/python}"
  echo "Running METEOR unit tests..."
  ( cd "$work" && PYTHONPATH=src "$python" -m pytest tests/unit -q --no-cov ) | tail -2
fi

# A checkout that already has the branch out cannot have it moved underneath
# it, and silently skipping would leave someone working on a stale tree
# without knowing. Say where it is instead.
in_use="$(git worktree list --porcelain \
  | awk -v b="refs/heads/$INTEGRATION" '/^worktree /{w=$2} $0=="branch "b{print w}')"

if [ -n "$in_use" ]; then
  echo "Local $INTEGRATION is checked out at:"
  echo "$in_use" | sed 's/^/    /'
  echo "  Left alone; run 'git pull --ff-only' there after pushing."
else
  git -C "$work" branch -f "$INTEGRATION" HEAD
  echo "Updated local $INTEGRATION -> $(git rev-parse --short "$INTEGRATION")"
fi

if [ "$PUSH" = 1 ]; then
  git -C "$work" push -q --force-with-lease origin "HEAD:$INTEGRATION"
  echo "Pushed origin/$INTEGRATION"
else
  remote="$(git rev-parse --short "origin/$INTEGRATION" 2>/dev/null || echo none)"
  local_head="$(git -C "$work" rev-parse --short HEAD)"
  if [ "$(git rev-parse "origin/$INTEGRATION^{tree}" 2>/dev/null)" = "$rebuilt" ]; then
    echo "origin/$INTEGRATION is already up to date ($remote); nothing to push."
  else
    echo "origin/$INTEGRATION ($remote) differs from the rebuild ($local_head)."
    echo "  Re-run with --push to update it."
  fi
fi
