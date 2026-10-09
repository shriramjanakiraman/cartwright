# 5. Run tools on demand at pinned versions

**Status:** Accepted · **Date:** 2026-10-10 · **Deciders:** team lead, architect

## Context
Skills (ours and Salesforce's) call the B2C CLI, spec-kit and graphify. Installing each was the most common
first-run failure, and installed copies drift apart between developers.

## Decision
`tools/run.mjs` in the plugin uses an installed copy at or above the version pinned in `upstream.lock.json`;
otherwise (or when it's older) it fetches the pinned version on demand with `npx` or `uvx` and caches it. The
daily upstream check moves the pins and smoke-tests each new version before proposing it. The session-start
hook tells agents which tools are missing.

## Alternatives considered
- **Host the tools centrally:** would need clients' credentials and code on a shared service.
- **Bundle binaries in the plugin:** platform builds, size, update burden.
- **Keep telling developers to install:** the failure we set out to remove.

## Consequences
A machine needs only Node, git and uv. First runs download (seconds); agent sandboxes and blocked registries
need approval or a mirror. `CARTWRIGHT_PREFER_INSTALLED=1` keeps pre-approved installs.

## Links
`documentation/13-tools-without-install.md`; pull request #31.
