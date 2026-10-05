# Changelog

All notable changes to what users receive. Newest first.

## [Unreleased]

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
