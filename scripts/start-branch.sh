#!/usr/bin/env sh
# Start work on a correctly named branch from the correct base (see GOVERNANCE.md and AGENTS.md).
#   feature <name>   new skill, capability, improvement, docs        from develop → PR into develop
#   bugfix  <name>   fix something that's wrong but not urgent        from develop → PR into develop
#   hotfix  <name>   urgent fix to what's already released            from main    → PR into main
#   release <x.y.z>  cut a release (version + CHANGELOG only)         from develop → PR into main
# Usage: sh scripts/start-branch.sh feature sfra-unit-tests      (or: npm run branch -- feature sfra-unit-tests)
set -e
TYPE="$1"; NAME="$2"
fail() { echo "start-branch: $1"; exit 1; }
[ -n "$TYPE" ] && [ -n "$NAME" ] || fail "usage: sh scripts/start-branch.sh <feature|bugfix|hotfix|release> <name>"
case "$TYPE" in
  feature|bugfix) BASE=develop ;;
  hotfix)         BASE=main ;;
  release)        BASE=develop; echo "$NAME" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "release needs a version like 0.6.0, got '$NAME'" ;;
  *) fail "type must be feature, bugfix, hotfix or release (got '$TYPE')" ;;
esac
[ "$TYPE" = release ] || echo "$NAME" | grep -Eq '^[a-z0-9]+(-[a-z0-9]+)*$' || fail "name must be lowercase words joined by hyphens, e.g. scrub-false-positive (got '$NAME')"
BRANCH="$TYPE/$NAME"
[ -z "$(git status --porcelain)" ] || fail "you have uncommitted changes; commit or stash them first"
git fetch -q origin || fail "could not fetch origin; check your GitHub access"
git show-ref -q --verify "refs/remotes/origin/$BRANCH" && fail "$BRANCH already exists on origin; pick another name or check it out"
git checkout -q -b "$BRANCH" "origin/$BASE"
TARGET=develop; [ "$TYPE" = hotfix ] || [ "$TYPE" = release ] && TARGET=main
echo "On $BRANCH (from origin/$BASE). When done:"
echo "  npm run check && git push -u origin $BRANCH && gh pr create --base $TARGET"
