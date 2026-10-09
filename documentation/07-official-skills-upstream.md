# Official skills (upstream)

The library bundles every official Salesforce B2C skill, plus a few other tools our skills rely on, so one
install gives developers everything. They're mirrored into `upstream/` at pinned versions and never edited
here. A daily check proposes updates as a pull request.

## What's pinned

`upstream.lock.json` records each source and the exact version mirrored:

| Source | What it provides |
|---|---|
| `b2c-developer-tooling` | the official B2C skills (CLI, platform, Storefront Next) |
| `b2c-dx-mcp` | the B2C MCP server version shipped with the Claude Code plugin |
| `b2c-cli` | the B2C CLI (`b2c`) version that `tools/run.mjs` runs when it isn't installed |
| `commerce-apps` | the Commerce Apps skills |
| `storefront-next-template` | tracked for changes; its skills aren't bundled (they only work inside a template project) |
| `spec-kit` | the `specify` version `tools/run.mjs` runs when it isn't installed |
| `graphify` | the `graphify` version `tools/run.mjs` runs when it isn't installed |

**Never edit `upstream/` or `upstream.lock.json` by hand.** CI fails if `upstream/` differs from the pinned
sources.

## The daily check

```
06:00 UTC  upstream-schedule (on main) ──▶ upstream-watch (on develop)
                                            ├─ compare the lock with what each publisher ships today
                                            ├─ nothing new? stop
                                            ├─ mirror, rebuild, run every CI check itself
                                            └─ open or refresh ONE pull request:
                                               feature/upstream-updates ──▶ develop
```

- There's only ever **one** upstream pull request. Each day with changes refreshes it (the branch is
  rebuilt and force-pushed), so never commit to `feature/upstream-updates` yourself.
- Because a workflow opens it, the pull request gets no checks of its own; `upstream-watch` runs validate,
  scrub, the mirror check and the build check before opening it.
- Start it by hand: `gh workflow run upstream-watch.yml --ref develop` (or `upstream-schedule.yml` to test
  the trigger).

## Reviewing the upstream pull request

The body lists version bumps and the official skills added or removed, then a checklist:

- **Our skills that reference a changed upstream skill.** Check each still works.
- **New official skills.** Check none of ours now duplicates them.
- **Possible overlaps with our skills.** Named pairs where a new or changed official skill may repeat one
  of ours, with a suggestion: deprecate ours in favour of the official one, or make ours build on it
  ([Duplicate check](05-duplicate-check.md)).
- **Version bumps.** Check the skills that install these tools still work against the new version.
- **Tool versions smoke-tested.** The B2C CLI, spec-kit and graphify are run once at their pinned versions;
  each line shows ✅ or ❌. Don't merge past a ❌ until it's understood
  ([Run tools without installing](13-tools-without-install.md#staying-up-to-date)).

The pull request also adds its own entries under *Unreleased* in `CHANGELOG.md` (regenerated on every
refresh, so they always describe everything waiting):

| Upstream change | CHANGELOG section | Effect on the weekly release |
|---|---|---|
| new official skills | *Added* | minor |
| version bumps | *Changed* | minor |
| official skills removed or renamed | *Changed* | minor |

Don't change `package.json`. Merge it into `develop` like any other pull request; it ships with the next
[release](06-releases.md). To reword an entry, do it in a small follow-up pull request, never on the
upstream branch.

## Running the scripts yourself

```bash
GH_TOKEN=$(gh auth token) npm run upstream     # report only; exit 10 means changes were found
node scripts/upstream-check.mjs --write        # also update the lock
node scripts/upstream-check.mjs --changelog    # also add the entries under CHANGELOG "Unreleased"
npm run sync-upstream                          # re-mirror upstream/ from the lock
npm run sync-upstream:check                    # CI: fail if the mirror differs from the lock
```

Setting a GitHub token avoids API rate limits.

## Timing

Adopting a brand-new upstream release immediately is a choice; waiting a couple of days before merging
lets publishers fix early problems.
