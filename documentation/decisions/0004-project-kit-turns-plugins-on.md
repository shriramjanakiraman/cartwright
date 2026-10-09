# 4. A project kit in the client repo turns the plugins on

**Status:** Accepted · **Date:** 2026-10-06 · **Deciders:** team lead, architect

## Context
Developers on an engagement should get core plus that client's skills without installing a second plugin or
editing settings, in Claude Code, Codex and Copilot alike.

## Decision
Client setup (a session-start hook plus the `client-setup` skill) asks which client, finds the overlay,
checks access, and after asking adds a small **kit** to the client repo through a pull request:
`.claude/settings.json`, `.github/copilot/settings.json`, `.agents/plugins/marketplace.json` +
`.codex/config.toml`, and `AGENT-SKILLS.md`. It holds pointers only, on any git host.

## Alternatives considered
- **Bundle every overlay into core:** breaks client privacy.
- **The core plugin fetches overlays itself on each session:** no files in the client repo, but more moving
  parts and credential handling inside the plugin.
- **Only tell the developer to ask their lead:** every developer stays set up only on their own machine.

## Consequences
Whoever opens the project is offered both plugins. Limits: Copilot applies declared plugins only in
interactive sessions; VS Code ignores them for now; Copilot installs per person. Credentials are each
developer's own git access.

## Links
`documentation/12-client-setup.md`; pull request #23; the live test (#36).
