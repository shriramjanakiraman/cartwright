# Changelog

All notable changes to what users receive. Newest first.

## [Unreleased]

### Changed
- The upstream check runs daily instead of weekly, and keeps one standing pull request
  (`feature/upstream-updates` into `develop`) that each run refreshes, instead of one per run.
- The upstream check runs validate, scrub, sync and build checks itself before proposing an update,
  because pull requests opened by a workflow don't trigger CI automatically.

### Added
- `AGENTS.md` (and `CLAUDE.md` pointing to it): AI agents classify each change as feature, bugfix, hotfix
  or release themselves, say which and why, branch accordingly, and stop at an open pull request.
- `npm run branch -- <type> <name>`: starts a correctly named branch from the right base, after listing
  the open pull requests. `AGENTS.md` tells agents to add to a related open pull request in the same repo when it's safe
  (same topic and kind, a human-owned branch) instead of opening another; with none open, they just branch.
- `npm run release -- <x.y.z>`: cuts `release/<x.y.z>` from `develop` (or prepares a `hotfix/` branch in
  place), sets the version, dates the CHANGELOG section, rebuilds, checks and commits. `AGENTS.md`
  gains the full release and hotfix procedure, including how to pick the version and resolve the
  CHANGELOG conflict in the post-release sync.
- Branching model: `main` (stable, what users install) and `develop` (test bed). Every change, owners
  included, arrives through a pull request from one of four branch types: `feature/`, `bugfix/` (into
  `develop`), `release/<x.y.z>` and `hotfix/` (into `main`).
- `release-gate`: pull requests into `main` must come from `release/` or `hotfix/`, bump the version
  (matching a `release/` branch name) and have a CHANGELOG section. Merging publishes the tag and release
  notes, then opens a pull request syncing `main` back into `develop`.
- `branch-name`: fails pull requests from wrongly named branches or aimed at the wrong target.
- `branch-guard`: flags and opens an issue for any commit that reaches `main` or `develop` without a
  merged pull request. Pre-push hook refuses direct pushes and unknown branch names locally.
- `scripts/protect-branches.sh`: applies the GitHub rulesets to core or an overlay once the plan allows.

### Changed
- The weekly upstream check now opens its pull request against `develop`.
- `skill-intake` 0.3.0 works on `feature/` (or `bugfix/`) branches into `develop`.
- The weekly upstream check names its branch `feature/upstream-<date>`.
- Overlay template gains the same branches, hooks and guards.

## [0.4.0] - 2026-10-05

### Added
- `skill-intake`: the first core skill. Walks a developer from an idea, a just-finished workflow or an
  existing project skill to an open pull request: duplicate check, core-or-overlay decision, draft,
  scrub, validation, and submission after an explicit yes.
- `npm run find` (`scripts/find-skill.mjs`): search our skills, all bundled official skills and an
  optional overlay by name and description.
- `npm run new-skill` (`scripts/new-skill.mjs`): create a correctly labelled draft, core or overlay,
  with owner, version, date and project labels filled in.

### Changed
- Contributors no longer bump `package.json`; the owner sets the library version at release.

## [0.3.0] - 2026-10-01

### Added
- Project overlays build into their own private plugin (`scripts/build-overlay.mjs`), enabled per client
  project through a generated `client-project-settings.json`.
- `validate --overlay`: project skills must be prefixed with the project code, carry `project:`, start their
  description with `Project <code> only:`, and not reuse a core or official name.
- Overlay starter kit: `overlay.json`, a project skill template, and CI that runs the core checks.

## [0.2.0] - 2026-10-01

### Changed
- One install now delivers everything: the plugin bundles every official Salesforce B2C Commerce skill
  (75, mirrored read-only into `upstream/` at the pinned versions, with their Apache-2.0 licences) and
  registers the B2C MCP server, alongside our own skills.
- `skills/common/` and `skills/sfcc/` are replaced by a single `core/` folder for every skill we write.
  The `scope` field is gone; use `applies-to`.
- `link` now gives non-plugin agents the same full set by linking built skill folders.

### Added
- `sync-upstream` script and CI check; the upstream watch now re-mirrors and rebuilds in its pull request.

## [0.1.0] - 2026-10-01

### Added
- Repository scaffold: contribution standard, governance, skill template, project overlay template.
- Door A: `upstream.lock.json` pinning official sources, `upstream-check` script, weekly `upstream-watch` workflow.
- Door B: `validate`, `scrub-scan`, pre-commit hook, CI, generated Claude Code plugin and `INDEX.md`,
  `link` for other agents, `check-updates` staleness nudge.
