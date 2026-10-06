# Releases

Nothing reaches users until it's released into `main`. Releases happen **weekly and automatically**
when there's something to release; anyone can still cut one by hand when the owner asks. Overlays release
the same way ([Project overlays](09-project-overlays.md#releases)).

## The weekly release

Every **Wednesday at 00:00 IST** (Tuesday 18:30 UTC), `release-schedule` on `main` starts `weekly-release`
on `develop`. It:

1. **Skips the week** if a release pull request is still open, or the previous release's `main → develop`
   sync hasn't been merged.
2. **Reads *Unreleased* in `CHANGELOG.md`** on `develop` and picks the version:

   | *Unreleased* contains | Release | Example |
   |---|---|---|
   | nothing | none this week | |
   | only *Fixed* or *Security* entries | patch | 0.5.0 → 0.5.1 |
   | any *Added*, *Changed* or *Deprecated* entry | minor | 0.5.0 → 0.6.0 |
   | any *Removed* entry, or an entry starting `- BREAKING:` | none; the owner decides on a major | 0.x → 1.0.0 |

3. **Cuts `release/<x.y.z>`**, sets the version, turns *Unreleased* into `## [x.y.z] - <date>`, rebuilds,
   runs every check, pushes and opens the pull request into `main` with the release notes. Then it stops.
4. **Opens a "Weekly release needs you" issue** instead of releasing when the owner has to act: a possible
   major, or commits on `develop` that aren't released while *Unreleased* is empty. Later weeks comment on
   the same issue. Close it once handled.

The owner reviews and merges the release pull request. Majors are always the owner's decision.

## What merging a release does

```
release/<x.y.z> ──PR──▶ main ──▶ release-gate checks ──▶ merge
                                                          │
                                   release workflow ◀─────┘
                                   ├─ tags v<x.y.z> and publishes the release notes
                                   └─ opens "Sync main into develop after v<x.y.z>" ──▶ merge it too
```

- `release-gate` refuses a pull request into `main` unless it comes from `release/` or `hotfix/`, the
  version is new (not already tagged), a `release/` branch name matches the version, and `CHANGELOG.md`
  has that version's section.
- The sync pull request is opened by a workflow, so its checks show as failed or missing. That's expected;
  CI runs on `develop` once it's merged. If it conflicts in `CHANGELOG.md`, resolve it on a
  `bugfix/sync-<x.y.z>` branch: keep every released section exactly as on `main`, and anything added since
  under *Unreleased*.
- Users then receive it: Claude Code through the plugin update, other agents on their next pull and
  `link` ([Getting started](01-getting-started.md)).

## Releasing by hand

```bash
npm run release                 # picks patch or minor from the CHANGELOG, like the weekly run
npm run release -- 0.7.0        # a chosen version (required for a major)
git push -u origin release/<x.y.z>
gh pr create --base main --title "Release <x.y.z>"
```

The script refuses a version that isn't newer than the current one and the latest tag, an empty
*Unreleased*, an existing `release/<x.y.z>`, and uncommitted changes. It never pushes; you do, after
reviewing the commit.

To add more merged `develop` work to an open release branch, merge `develop` into it and fold the CHANGELOG
into the single version section.

## Hotfixes

For something already released that is actively harming users and can't wait for Wednesday. Agree it
with the owner first, then:

```bash
npm run branch -- hotfix <name>        # from main
# fix it, add a "### Fixed" line under Unreleased
npm run release                        # prepares the patch release on the hotfix branch itself
git push -u origin hotfix/<name>
gh pr create --base main
```

Merging it tags the release and syncs it back into `develop` like any other.

## Known gap

Merging the daily upstream pull request doesn't add a CHANGELOG line, and that branch can't be committed
to (the upstream check force-pushes it). Until that's fixed, a week with only upstream changes produces
the "Weekly release needs you" issue: add the CHANGELOG line through a small pull request and the next run
releases it.

## Files

| File | Role |
|---|---|
| `scripts/next-version.mjs` | picks patch or minor from *Unreleased* |
| `scripts/cut-release.mjs` | cuts the release branch (`--overlay <repo>` for overlays) |
| `.github/workflows/release-schedule.yml` | the Wednesday trigger, on `main` |
| `.github/workflows/weekly-release.yml` | decides, cuts and opens the pull request, from `develop` |
| `.github/workflows/release-gate.yml` | checks pull requests into `main` |
| `.github/workflows/release.yml` | tag, release notes and sync after merge |
