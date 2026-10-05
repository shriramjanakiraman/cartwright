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
skill, a script fix or an upstream update, arrives through a reviewed pull request.

| Branch | Purpose | Changes arrive from |
|---|---|---|
| `main` | Stable. What users install: the plugin marketplace and `link` read from it. Every commit is a release. | Release pull requests from `develop` (or `hotfix/*` for urgent fixes) |
| `develop` | Integration and test bed. New skills and features land here first and get tried before release. | Feature pull requests |
| `skill/<name>`, `feat/<topic>`, `fix/<topic>`, `chore/<topic>` | One change each, branched from `develop` | Their author |
| `upstream/<date>` | Created by the weekly upstream check | The upstream-watch workflow |
| `hotfix/<topic>` | Urgent fix, branched from `main` | Their author; merged into `main`, then back into `develop` |

**Flow for any change:** branch from `develop` → open a pull request into `develop` → CI passes → owner
merges → try it on `develop` → owner opens a release pull request from `develop` into `main`.

**Releasing:** the release pull request bumps `package.json` to the new version and turns the CHANGELOG's
*Unreleased* section into `## [X.Y.Z] - date`. The `release-gate` check refuses it unless it comes from
`develop` or `hotfix/*`, the version is new, and the CHANGELOG has the matching section. Merging it
publishes the `vX.Y.Z` tag and release notes automatically.

**The same applies to overlay repos:** each has `main` and `develop`, the same pull request rule, and the
same guards. Overlay changes are approved by the core owner or that engagement's project lead.

### How it's enforced

| Guard | What it does | Status |
|---|---|---|
| GitHub rulesets (`scripts/protect-branches.sh <owner/repo>`) | Blocks direct pushes, force pushes and deletion of `main` and `develop`; requires a pull request with passing checks. No bypass, owners included. | **Needs a plan that supports it**: GitHub Pro, a Team/Enterprise organisation, or a public repo. Not available on the current free private repo. |
| Pre-push hook (`npm run setup-hooks`) | Refuses a direct push to `main` or `develop` from your machine | Active wherever hooks are enabled. Can be bypassed with `--no-verify`, so it catches mistakes, not intent. |
| `branch-guard` workflow | Fails and opens an issue if a commit lands on `main` or `develop` without a merged pull request | Active. Detects after the fact; can't prevent. |
| `release-gate` workflow | Checks every pull request into `main` is a proper release | Active |

When the repo moves to a plan that supports rulesets, run `sh scripts/protect-branches.sh <owner/repo>`
once (and once per overlay with `--overlay`). Required approvals start at 0 so a solo owner can merge;
raise them when co-owners join.

## Visibility

The core repo is **private** while the library is being piloted. Overlay repos are always private and
limited to the engagement team.

## Releases

- `package.json` holds the library version. The owner sets it in the release pull request; contributors
  only add `CHANGELOG.md` entries under *Unreleased*. Each skill also carries its own `version`.
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
