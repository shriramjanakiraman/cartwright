# Duplicate check

Stops the library filling up with skills that repeat each other. Every pull request that adds or changes a
skill is checked against the skills that already exist. A likely repeat holds the pull request until
someone decides what to do about it.

## What's compared with what

| A skill in… | is compared with | never with |
|---|---|---|
| core | core skills and the official skills | any overlay |
| an overlay | that overlay's skills, core and the official skills | other overlays |
| the official mirror (new or changed upstream) | our core skills | (reported in the upstream pull request, see below) |

Only skills **added or changed in the pull request** are checked, so an unrelated pull request never fails
because something similar appeared elsewhere. A skill is never flagged against a skill it lists in
`depends-on` (building on another skill is the intended pattern), and deprecated skills are ignored.

Client privacy is kept: core can't see overlays, overlays can't see each other, and nothing is sent outside
GitHub.

## How "similar" is decided

Offline, by comparing **names and descriptions**, which is what agents use to pick a skill. Words are
weighted by how distinctive they are across all skills (TF-IDF), and the two skills get a similarity score
from 0 to 1. At **0.35** or more, the pair is reported. For calibration: rewrites of an existing official
skill scored 0.44 to 0.49, distinct official skills that Salesforce keeps separate score up to about 0.40,
and unrelated skills stay near 0.1. So some reports will be borderline on purpose. The comment asks a
person to decide; it isn't a verdict.

Try it before you push:

```bash
node scripts/similar-skills.mjs core/<name>.md
node scripts/similar-skills.mjs --overlay ../<code>-cartwright skills/<code>-<name>.md
```

## What happens on a pull request

```
 push ──▶ duplicate-check ──▶ likely repeat? ──no──▶ ✔ duplicates passes
                                   │
                                  yes
                                   ▼
          comment on the skill file + "Request changes" + ✘ duplicates fails
                                   │
          reply with the decision ─┤
          resolve the conversation │
          add any comment ─────────┴──▶ duplicate-recheck re-runs the check
                                              │
                         all resolved? ──yes──▶ ✔ passes, bot's review dismissed
```

1. **The bot comments on the skill's file.** It names the other skill and where it lives, the similarity
   and the words they share, and suggests what to do:
   - an **official** skill: use it instead, or build on it (add it to `depends-on` and keep only what's
     different). Official skills are never edited here.
   - one of **our** skills: improve that one instead, or combine the two. If they're deliberately
     different, make the difference clear in both descriptions.
   - for an **overlay** skill that resembles a **core** one: build on the core skill and keep only the
     client-specific part.
2. **The pull request gets "Request changes"** and the `duplicates` check fails.
3. **Anyone decides and fixes it**, the author or a reviewer: change the skill if needed, reply to the
   comment with the decision, then **resolve** the conversation.
4. **Add a comment** in that conversation (or anywhere on the pull request, or press *Re-run*). GitHub
   doesn't start workflows when a conversation is resolved, so this nudge is what re-runs the check.
5. When every duplicate comment is resolved, the check passes and the bot dismisses its review.

A pair is commented on only once. After it's resolved, later pushes don't raise it again, even if the
skill changes.

## Can it be merged anyway?

Not intentionally. On the current free plan GitHub can't lock the merge button, so as a backstop
`branch-guard` opens an issue titled "#N merged with unresolved duplicate comments" if a pull request is
merged with one still open. Fix it, or resolve it with a decision, before the next release ships it. After
moving to GitHub Pro or an organisation, the required `duplicates` check and "require conversation
resolution" make it a hard block ([Branches and pull requests](04-branches-and-pull-requests.md#github-plan-limits)).

## Official skills that repeat ours

When Salesforce ships a new or changed official skill, the daily upstream pull request includes a
*Possible overlaps with our skills* section naming any of our skills it may repeat, with the same kind of
suggestion: deprecate ours in favour of the official one, or make ours build on it. See
[Official skills](07-official-skills-upstream.md).

## Moving to AI review later

The check is deliberately offline for now. If the library moves to an enterprise GitHub organisation with
Copilot, an AI review can be added to judge "same job" better than word overlap. For overlays, that would
mean sending client skill text to the AI service, which needs the client's agreement.

## Files

| File | Role |
|---|---|
| `scripts/similar-skills.mjs` | scoring and the CLI |
| `scripts/duplicate-review.mjs` | comments, review, pass or fail |
| `.github/workflows/duplicate-check.yml` | runs on pull requests (job `duplicates`) |
| `.github/workflows/duplicate-recheck.yml` | re-runs it on replies and pull request comments |
| `.github/workflows/branch-guard.yml` | backstop issue after a merge |
| `templates/overlay/.github/workflows/` | the same two workflows for overlays |
