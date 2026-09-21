#!/usr/bin/env bash
#
# Cuts a release: writes one version everywhere the product records it,
# commits that, and creates the annotated tag.
#
#   scripts/release.sh 0.2.0
#
# It never pushes. Pushing the tag is what publishes images to GHCR, so that
# step stays a deliberate command you run, and this prints both of them.
#
# `scripts/ci.sh version` defines where versions live and verifies the result
# here before anything is committed. The release workflow runs the same check
# against the pushed tag, so a tag cut by hand without this script still
# cannot publish images whose admin page reports a different version.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-}"
TAG="v$VERSION"

die() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
  exit 1
}

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] ||
  die "usage: $0 X.Y.Z   (a version such as 0.2.0, without the leading v)"

cd "$ROOT"
# A release commit must contain the version bump and nothing else, or the tag
# would quietly carry whatever else was lying in the working tree.
git diff --quiet && git diff --cached --quiet ||
  die "the working tree has uncommitted changes; commit or stash them first"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "$TAG already exists"
fi

# Rewrites the version on one line of a file: the first line matching the
# pattern, or with "after", the line that follows it. The version is the first
# quoted string starting with a digit, which is the value in every format here
# and never the key. Through awk and a temporary file rather than sed -i,
# whose syntax differs between macOS and Linux. Fails rather than writing when
# the line is not found, so a changed file format cannot be skipped silently.
set_version() {
  local file="$1" pattern="$2" where="${3:-on}" tmp
  tmp="$(mktemp)"
  if ! awk -v pat="$pattern" -v where="$where" -v v="$VERSION" '
    !done && $0 ~ pat {
      if (where == "after") { print; if ((getline) <= 0) exit 1 }
      if (sub(/"[0-9][^"]*"/, "\"" v "\"") != 1) exit 1
      done = 1
    }
    { print }
    END { if (!done) exit 1 }
  ' "$file" >"$tmp"; then
    rm -f "$tmp"
    die "could not find the version in $file"
  fi
  mv "$tmp" "$file"
}

set_version apps/api/Cargo.toml '^version = "'
# Cargo owns its own lockfile and rewrites exactly this one entry, offline.
(cd apps/api && cargo update --workspace --offline --quiet)

for manifest in apps/*/package.json packages/*/package.json; do
  set_version "$manifest" '^  "version": "'
  name="$(grep -m1 '^  "name": "' "$manifest" | cut -d'"' -f4)"
  # bun records the workspace version but never rewrites it when only the
  # version changes, and --frozen-lockfile accepts the stale value.
  set_version bun.lock "\"name\": \"$name\"," after
done

./scripts/ci.sh version "$TAG" >/dev/null ||
  die "a recorded version does not match $TAG; run ./scripts/ci.sh version $TAG to see which"

git add -A
git commit -q -m "release: $VERSION"
git tag -a "$TAG" -m "krypta $VERSION"

printf '\033[32mTagged %s at %s.\033[0m Nothing has been pushed. To publish:\n\n' \
  "$TAG" "$(git rev-parse --short HEAD)"
printf '  git push origin %s\n' "$(git branch --show-current)"
printf '  git push origin %s\n' "$TAG"
