#!/usr/bin/env sh
# Cheap staleness check for consumers (Door B). Prints how far this checkout is behind origin.
# Exit 0 = current, 1 = behind (run: git pull && npm run link -- --agent <agent>), 2 = could not check.
# Skills call this from their fast prerequisite step instead of re-running a full sync every time.
REPO="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
git -C "$REPO" fetch --quiet origin 2>/dev/null || { echo "agent-skills: could not reach origin"; exit 2; }
BEHIND=$(git -C "$REPO" rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
if [ "$BEHIND" -gt 0 ]; then
  echo "agent-skills: $BEHIND commit(s) behind. Update: git -C \"$REPO\" pull && (cd \"$REPO\" && npm run link -- --agent <agent>)"
  exit 1
fi
echo "agent-skills: up to date ($(git -C "$REPO" describe --tags --always 2>/dev/null))"
