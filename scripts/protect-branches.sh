#!/usr/bin/env sh
# Apply the branching rules from GOVERNANCE.md as GitHub rulesets, on the core repo or any overlay repo.
#   main:    pull request required; CI, branch-name and (core) release-gate must pass; no direct push,
#            force push or deletion
#   develop: pull request required; CI and branch-name must pass; no direct push, force push or deletion
# No bypass for anyone, owners included. Safe to re-run: existing rulesets with the same name are updated.
#
# Usage: sh scripts/protect-branches.sh <owner/repo> [--overlay]
# Needs: gh signed in with admin on the repo. Rulesets require a public repo, GitHub Pro (personal
# accounts), or a Team/Enterprise organisation plan. On a free private repo GitHub returns 403.
set -e
REPO="$1"; MODE="$2"
[ -n "$REPO" ] || { echo "usage: sh scripts/protect-branches.sh <owner/repo> [--overlay]"; exit 2; }
CI_CHECK="check"
if [ "$MODE" = "--overlay" ]; then GATE=""; else GATE="release-gate"; fi

ruleset() { # name, branch, extra-required-check
  NAME="$1"; BRANCH="$2"; EXTRA="$3"
  CHECKS="{\"context\":\"$CI_CHECK\"},{\"context\":\"branch-name\"}"
  [ -n "$EXTRA" ] && CHECKS="$CHECKS,{\"context\":\"$EXTRA\"}"
  BODY=$(cat <<JSON
{
  "name": "$NAME",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/heads/$BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ $CHECKS ] } }
  ]
}
JSON
)
  ID=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"$NAME\") | .id" 2>/dev/null || true)
  if [ -n "$ID" ]; then
    echo "$BODY" | gh api -X PUT "repos/$REPO/rulesets/$ID" --input - >/dev/null && echo "updated: $NAME"
  else
    echo "$BODY" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null && echo "created: $NAME"
  fi
}

if ! gh api "repos/$REPO/rulesets" >/dev/null 2>&1; then
  echo "GitHub won't allow rulesets on $REPO with its current plan (free private repo)."
  echo "Options: GitHub Pro for the owning account, a Team/Enterprise organisation, or a public repo."
  echo "Until then the pre-push hook and the branch-guard workflow are the only guards."
  exit 1
fi
ruleset "protect-main" main "$GATE"
ruleset "protect-develop" develop ""
echo "Done. Required approvals are 0 so a solo owner can merge; raise required_approving_review_count when co-owners join."
