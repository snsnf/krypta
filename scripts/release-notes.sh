#!/usr/bin/env bash
#
# Prints draft release notes for a tag, for the release workflow to open as a
# draft GitHub Release:
#
#   scripts/release-notes.sh v0.2.0
#
# "What's new" lists every commit since the previous tag, to be rewritten into
# plain sentences before publishing. "Upgrade notes" is filled in with what can
# be detected here: a new migration, which runs on start and cannot be undone,
# and a changed configuration template. Anything else an operator must do, such
# as enabling a Stripe webhook event, is added by hand.

set -euo pipefail

TAG="${1:?usage: $0 vX.Y.Z}"
cd "$(dirname "$0")/.."

PREV="$(git describe --tags --abbrev=0 --match 'v*' "$TAG^" 2>/dev/null || true)"

echo "## What's new"
echo
# The release commit itself only bumps the version, so it is left out.
git log --no-merges --format='- %s' "${PREV:+$PREV..}$TAG" | grep -v '^- release: ' || true

# A first release has nothing to upgrade from.
[ -n "$PREV" ] || exit 0

notes=()
while IFS= read -r migration; do
  [ -n "$migration" ] || continue
  notes+=("- Adds the database migration \`$(basename "$migration")\`. It runs automatically on start and cannot be undone, so run \`./backup.sh\` before upgrading.")
done < <(git diff --name-only --diff-filter=A "$PREV" "$TAG" -- apps/api/migrations)
if ! git diff --quiet "$PREV" "$TAG" -- infra/docker/.env.prod.example; then
  notes+=("- The configuration template changed. Compare your \`.env.prod\` with \`.env.prod.example\` before upgrading.")
fi

echo
echo "## Upgrade notes"
echo
if [ ${#notes[@]} -gt 0 ]; then
  printf '%s\n' "${notes[@]}"
fi
echo "<!-- Add anything that must be done outside krypta, such as a new Stripe webhook event. Delete this section if it stays empty. -->"
