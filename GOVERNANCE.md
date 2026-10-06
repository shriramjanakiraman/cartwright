# Governance

## Ownership

| Area | Owner | Approves |
|---|---|---|
| Core repo (`skills/`, scripts, standards) | @shriramjanakiraman | Every pull request |
| Door A pull requests (upstream changes) | @shriramjanakiraman | Every lock update |
| Project overlay repos | @shriramjanakiraman or that engagement's named leads | Changes in that overlay |
| Promotions from an overlay into core | @shriramjanakiraman | The core pull request, after the overlay lead confirms the scrub |

Ownership is recorded in `.github/CODEOWNERS`. When more owners join, add them there and here in the
same pull request.

## Branches and pull requests

Nobody changes `main` or `develop` directly, owners included. Every change, a new core skill, an overlay
skill, a script fix or a Salesforce update, arrives through a reviewed pull request.

**Two long-lived branches:**

| Branch | Purpose |
|---|---|
| `main` | Stable. What users install: the plugin marketplace and `link` read from it. Every commit is a release. |
| `develop` | The test bed. New skills and features land here first and get tried before release. |

**Four kinds of working branch, and nothing else:**

| Branch | Use it for | Cut from | Pull request into |
|---|---|---|---|
| `feature/<name>` | New skills, new capabilities, improvements, docs. Salesforce updates arrive as `feature/upstream-<date>`. | `develop` | `develop` |
| `bugfix/<name>` | Fixing something on `develop` that hasn't been released yet | `develop` | `develop` |
| `release/<x.y.z>` | Cutting a release: set the version and CHANGELOG, nothing else | `develop` | `main` |
| `hotfix/<name>` | An urgent fix to what's already released | `main` | `main` |

Names are lowercase with hyphens, for example `feature/sfra-unit-tests` or `bugfix/scrub-false-positive`.
Start one with `npm run branch -- <type> <name>`, which picks the right base. AI agents classify the change
themselves using the rules in `AGENTS.md` and say which type they chose and why.

**Everyday flow:** cut `feature/` or `bugfix/` from `develop` → pull request into `develop` → checks pass
→ owner merges → try it on `develop`.

**Releasing:**

1. Cut `release/<x.y.z>` from `develop`.
2. Set `package.json` to `x.y.z` and turn the CHANGELOG's *Unreleased* section into `## [x.y.z] - date`.
3. Open a pull request into `main`. `release-gate` refuses it unless the branch is `release/` or `hotfix/`,
   the version is new and matches the branch name, and the CHANGELOG has the section.
4. Merging publishes the `vx.y.z` tag and release notes, and opens an automatic pull request syncing
   `main` back into `develop`. Merge that too.

A **hotfix** follows the same steps from step 2, cut from `main` with a patch version.

**The same applies to overlay repos:** `main` and `develop`, the same four branch types, the same pull
request rule and guards. Overlay changes are approved by the core owner or that engagement's project lead.

### How it's enforced

| Guard | What it does | Status |
|---|---|---|
| GitHub rulesets (`scripts/protect-branches.sh <owner/repo>`) | Blocks direct pushes, force pushes and deletion of `main` and `develop`; requires a pull request with passing checks. No bypass, owners included. | **Needs a plan that supports it**: GitHub Pro, a Team/Enterprise organisation, or a public repo. Not available on the current free private repo. |
| Pre-push hook (`npm run setup-hooks`) | Refuses a direct push to `main` or `develop`, and any branch not named `feature/`, `bugfix/`, `hotfix/` or `release/` | Active wherever hooks are enabled. Can be bypassed with `--no-verify`, so it catches mistakes, not intent. |
| `branch-name` workflow | Fails a pull request from a wrongly named branch, or one aimed at the wrong target | Active |
| `branch-guard` workflow | Fails and opens an issue if a commit lands on `main` or `develop` without a merged pull request | Active. Detects after the fact; can't prevent. |
| `release-gate` workflow | Checks every pull request into `main` is a proper release from `release/` or `hotfix/` | Active |

When the repo moves to a plan that supports rulesets, run `sh scripts/protect-branches.sh <owner/repo>`
once (and once per overlay with `--overlay`). Required approvals start at 0 so a solo owner can merge;
raise them when co-owners join.

## Visibility

The core repo is **private** while the library is being piloted. Overlay repos are always private and
limited to the engagement team.

## Releases

- `package.json` holds the library version. The owner sets it on the `release/<x.y.z>` branch;
  contributors only add `CHANGELOG.md` entries under *Unreleased*. Each skill also carries its own `version`.
- Every release has a `CHANGELOG.md` section, checked by `release-gate`.
- Merging the release pull request into `main` tags `vX.Y.Z` and publishes the notes automatically.
- Users receive releases through the plugin manager, `npm run link`, and the `check-updates` nudge.

## Review cadence

- **Weekly**, automatically: the upstream check (Door A).
- **Quarterly**: review every `active` skill. Update `last-reviewed`, or deprecate what is no longer used
  or is now covered upstream.

## Engagement end

When an engagement ends, its overlay repo is archived or deleted as the client contract requires. Anything
worth keeping must already have been promoted to core through a scrubbed pull request.

## Incidents

If client data or a secret reaches this repo:

1. Tell the owner immediately. Don't try to fix it with a new commit.
2. Rotate any exposed secret.
3. The owner rewrites history and force-pushes, then asks everyone with a clone to re-clone.
4. Add the leaked pattern to the scanner so it can't recur.
