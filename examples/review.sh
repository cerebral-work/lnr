#!/usr/bin/env bash
# Example: linearctl review "ENG-123" --pr 123 --repo owner/repo --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.7.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 7 )); then
  printf '%s\n' 'linearctl >= 0.7.0 is required' >&2
  exit 2
fi
: "${ISSUE:?Set ISSUE (for example ENG-123)}"
: "${REPO:?Set REPO (for example owner/repo)}"
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"
linearctl ratelimit --json
linearctl review "$ISSUE" --pr "${PR:?Set PR number}" --repo "$REPO" --json
linearctl show "$ISSUE" --json
