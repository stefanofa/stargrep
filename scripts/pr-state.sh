#!/usr/bin/env bash
# Prints OPEN, CLOSED, MERGED, or MISSING for pull request $1, and fails on any other gh error.
set -euo pipefail
if output=$(gh pr view "$1" --repo "$GITHUB_REPOSITORY" --json state --jq .state 2>&1); then
  echo "$output"
elif grep -q "Could not resolve to a PullRequest" <<<"$output"; then
  echo MISSING
else
  echo "$output" >&2
  exit 1
fi
