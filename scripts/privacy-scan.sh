#!/usr/bin/env bash
# Fails if any tracked file contains a term from the private deny-list (.privacy-denylist, one term per line, never committed).
# The list holds the author's own names, employers and numbers, so it must stay local. Public clones skip the check.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .privacy-denylist ] || { echo "no .privacy-denylist here; skipped"; exit 0; }
if git ls-files -z | xargs -0 grep -n -i -I -F -f <(grep -v '^\s*$' .privacy-denylist) -- 2>/dev/null | grep -v '^package-lock.json'; then
  echo "STOP: personal terms found in tracked files" >&2; exit 1
fi
echo "privacy scan clean"
