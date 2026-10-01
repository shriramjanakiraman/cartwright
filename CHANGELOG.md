# Changelog

All notable changes to what users receive. Newest first.

## [Unreleased]

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
