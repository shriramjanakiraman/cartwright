# Changelog

All notable changes to what users receive. Newest first.

## [Unreleased]

### Added
- End-to-end test (`npm run e2e`, `documentation/14-end-to-end-test.md`): on a simulated bare machine it
  checks packaging (Claude Code's validator, matching manifests), running tools without installing,
  the whole client-setup chain, that every plugin source in the project kit resolves for Claude Code,
  Copilot and Codex, and optionally a real pull request in the test client repo.

## [2.0.0] - 2026-10-09

A major release: the library is renamed **Cartwright**, so the plugin and install commands change. Uninstall
the old `agent-skills` plugin and install `cartwright@cartwright` (see *Changed*). Everything else carries on
as before, and now runs the B2C CLI, spec-kit and graphify without installing them.

### Added
- Run the B2C CLI, spec-kit and graphify without installing them. `tools/run.mjs` in the plugin uses an
  installed copy, or fetches the version pinned in `upstream.lock.json` on demand (`npx` for the B2C CLI,
  `uvx` for spec-kit and graphify) and caches it, so a machine needs only Node.js, git and uv. The
  session-start hook tells the agent which tools are missing and to run them through the helper, which also
  makes Salesforce's official skills work without the B2C CLI installed. New skill `tools-without-install`
  and guide `documentation/13-tools-without-install.md`. The B2C CLI (`@salesforce/b2c-cli`) is now a pinned
  source tracked by the daily upstream check.
- The tools stay current: the daily upstream check bumps their pins as they release and now smoke-tests every
  pinned tool (`run.mjs --smoke`, results in the upstream pull request) before the update is proposed. An
  installed copy older than the pin is skipped in favour of the pinned version, with the command to update it
  (`CARTWRIGHT_PREFER_INSTALLED=1` keeps the old behaviour for pre-approved installs).

### Changed
- BREAKING: the library is now **Cartwright**: Claude Code reserves the name `agent-skills`, so the plugin
  couldn't be installed under it. The repo becomes `shriramjanakiraman/cartwright` and the plugin
  `cartwright@cartwright` in Claude Code, Codex and Copilot. Reinstall with
  `claude plugin marketplace add shriramjanakiraman/cartwright` then `claude plugin install cartwright@cartwright`
  (Codex: `codex plugin marketplace add …` / `codex plugin add cartwright@cartwright`), and remove the old
  `agent-skills` plugin. Overlay repos and marketplaces are now named `<code>-cartwright` (plugins stay
  `<code>-skills`); the project kit, templates, guides and install commands use the new names. Per-user setup
  choices move to `~/.cartwright/`.

### Fixed
- `npm run branch` accepts a version in a branch name, so `bugfix/sync-1.2.0` (the name AGENTS.md gives for
  resolving a post-release sync conflict) no longer fails with "name must be lowercase words joined by
  hyphens".

## [1.2.0] - 2026-10-09

### Added
- Client setup: install the plugin once and, in any client project, get every shared SFCC skill plus the
  project skills other developers wrote for that client. A session-start hook (Claude Code, Codex, GitHub
  Copilot CLI and VS Code) offers setup in projects that aren't connected yet; the new `client-setup` skill
  asks which client, finds its project skills from any spelling or abbreviation ("AC" = "Acme Corporation"),
  checks access, and after asking adds a small project kit to the client repo (on any git host) and opens a
  pull or merge request, so everyone who opens the project gets both plugins with no setup. For a client
  with no project skills yet, it guides creating and registering them.
- An encrypted client registry (`registry/overlays.json`, `npm run registry`): finds a client's overlay
  from any of its names without the core repo containing any client name. Names are key-stretched (scrypt)
  and the details encrypted (AES-GCM); `npm run check` validates the file.
- The project kit (`.claude/settings.json`, `.github/copilot/settings.json`, `.agents/plugins/marketplace.json`,
  `.codex/config.toml`, `AGENT-SKILLS.md`) supports overlays on GitHub, GitLab, Bitbucket or any git host.
  `build-overlay` also writes it to `client-project/`, replacing `client-project-settings.json` (Claude Code only).
- The plugin ships the Agent Plugins 1.0 manifest (`plugin/plugin.json`, `plugin/mcp.json`) that GitHub
  Copilot CLI and VS Code read, plus `plugin/tools/` (the setup helper and registry) and `plugin/hooks/`.
- `overlay.json` gains `client`, `aliases` and `lead`.
- `documentation/12-client-setup.md`.
- Official skills from b2c-developer-tooling (b2c-ops): `b2c-edge-traffic-triage`.
- Official skills from b2c-dx-mcp (b2c-dx-mcp): `b2c-mcp-cip`, `b2c-mcp-config`, `b2c-mcp-debugger`, `b2c-mcp-scapi`, `b2c-mcp-server`.

### Changed
- Official sources updated: b2c-developer-tooling 1.11.0 → 1.12.0; b2c-dx-mcp 3.2.1 → 3.4.1; storefront-next-template a45f45b → 1d553d1; spec-kit v1.1.0 → v1.1.2; graphify 0.9.77 → 0.9.82.
- Official skills removed or renamed upstream in b2c-dx-mcp (b2c-dx-mcp): `b2c-config`, `cip`, `debugger`, `scapi`, `server`.

## [1.1.0] - 2026-10-06

### Added
- Codex plugin: the repo is now also a Codex plugin marketplace (`.agents/plugins/marketplace.json` and
  `plugin/.codex-plugin/plugin.json`, generated by `npm run build`), with the same skills and the B2C MCP
  server: `codex plugin marketplace add shriramjanakiraman/agent-skills`, then
  `codex plugin add agent-skills@agent-skills`. Overlays get the same through `build-overlay`.

## [1.0.0] - 2026-10-06

The first major release. Nothing in it breaks how the library is used today; 1.0.0 marks it as the
version teams can rely on, with weekly releases, the duplicate check and overlay releases in place.

### Added
- `documentation/`: one guide per feature (getting started, writing a skill, scrubbing, branches and pull
  requests, the duplicate check, releases, official skills, build and distribution, project overlays,
  promoting to core) and an automation reference, linked from the README.
- Duplicate check (`duplicate-check` workflow, core and the overlay template): every skill a pull request
  adds or changes is compared, offline, with the skills it can see. Core skills are compared with core and
  the official skills; overlay skills with their overlay, core and the official skills (never other
  overlays). Each likely repeat gets a comment with a suggestion (use, build on, or combine with the other
  skill), the pull request gets "Request changes", and the check fails until every comment is resolved.
  Skills listed in `depends-on` are never flagged. Run it yourself with `node scripts/similar-skills.mjs <file>`.
- `branch-guard` opens an issue when a pull request is merged with a duplicate comment still open (the
  free plan can't block the merge). `protect-branches.sh` requires the `duplicates` check for when
  rulesets are available.
- The upstream pull request lists new or changed official skills that may overlap ours.
- Weekly releases: every Wednesday at 00:00 IST, `weekly-release` cuts a release from `develop` and opens
  the pull request into `main`, but only when *Unreleased* in the CHANGELOG has entries. Fixes only → patch
  (0.5.0 → 0.5.1); anything added or changed → minor (0.5.0 → 0.6.0). Majors stay manual: *Removed* or
  `- BREAKING:` entries, or unreleased commits with no CHANGELOG entry, open an issue for the owner instead.
- `npm run release` without a version picks patch or minor from the CHANGELOG (`scripts/next-version.mjs`).

### Changed
- Official skills updated: b2c-developer-tooling 1.10.3 → 1.11.0. Storefront Next gains `sfnext-accessibility`,
  `sfnext-analytics-consent`, `sfnext-commerce-features`, `sfnext-overview`, `sfnext-quality-gates`,
  `sfnext-revalidation`, `sfnext-scapi`, `sfnext-security`, `sfnext-seo` and `sfnext-theming`. Salesforce
  removed or renamed `sfnext-create-component`, `sfnext-create-vertical`, `sfnext-custom-apis` and
  `sfnext-scapi-management`, so those are no longer delivered.
- Tracked tools updated: spec-kit v1.0.13 → v1.1.0, graphify 0.9.73 → 0.9.77, storefront-next-template
  `d0987c0` → `a45f45b`.
- `skill-intake` 0.4.0 → 0.4.3: releases are described correctly (they go through `release/`, not a
  `develop` merge); overlay branching and commit steps; a *Promoting a project skill to core* section;
  how to handle a duplicate-check comment. Both `AGENTS.md` files cover duplicate comments too.

### Fixed
- The daily upstream pull request now writes its own CHANGELOG entries under *Unreleased* (new official
  skills under *Added*; version bumps and official skills removed or renamed upstream under *Changed*), so
  an upstream-only week releases on its own as a minor release. Before, nothing added one and the
  upstream branch couldn't be committed to, so the weekly release stopped with an issue instead. Its checklist no longer tells
  reviewers to bump `package.json`.
- Overlay changes now have a way to reach the team. The overlay template said changes ship "when `develop`
  is merged into `main`", which its own `branch-name` rule refuses, and nothing ever raised the overlay's
  version, so Claude Code wouldn't pick up a change. Overlays now release like core: a `CHANGELOG.md`,
  `cut-release.mjs --overlay <repo>` (version in `overlay.json`), a weekly `weekly-release`, `release-gate`,
  and a tag plus `main → develop` sync on merge. The template also gains an `AGENTS.md` (with `CLAUDE.md`)
  so agents working in an overlay follow the same rules, and its README now covers changing a skill,
  releasing and how teammates pick up updates.
- `validate` refuses an active skill that still contains the skill template's stock text.
- Promoting a project skill to core is now documented end to end: split it, check the client denylist,
  core pull request, **wait for the core release** (the overlay's checks validate `depends-on` against
  core's `main`, so updating the overlay earlier fails), then trim or deprecate the overlay skill. Covered
  in the overlay README and `skill-intake`.
- `scrub-scan --denylist` refuses a missing or empty client list instead of passing without checking any
  client names.

## [0.5.0] - 2026-10-06

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
- The upstream check runs daily instead of weekly, from `develop`: GitHub only runs schedules from `main`,
  so a small `upstream-schedule` workflow there starts `upstream-watch` on `develop` each day, and changes
  to the check take effect as soon as they merge into `develop`. It raises its pull request into `develop`
  instead of `main`, and keeps one standing pull request (`feature/upstream-updates`) that each run
  refreshes, instead of one per run.
- The upstream check runs validate, scrub, sync and build checks itself before proposing an update,
  because pull requests opened by a workflow don't trigger CI automatically.
- `skill-intake` 0.4.0 starts its work with `npm run branch` on a `feature/` (or `bugfix/`) branch into `develop`.
- Overlay template gains the same branches, hooks and guards.

### Fixed
- CI secret scan can read pull request commits (it failed on the first pull request run).

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
