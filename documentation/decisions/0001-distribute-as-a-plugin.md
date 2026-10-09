# 1. Distribute Cartwright as a plugin

**Status:** Accepted · **Date:** 2026-10-06 · **Deciders:** team lead, architect

## Context
Developers use several agents (Claude Code, Codex, GitHub Copilot, Cursor and others). They need our skills,
Salesforce's official B2C skills and the B2C MCP server with as little setup as possible, kept up to date.
Claude Code, Codex and Copilot all have plugin marketplaces, and Salesforce ships its skills the same way.

## Decision
Cartwright is a plugin: one repo that is a marketplace for Claude Code (`.claude-plugin/`), Codex
(`.agents/plugins/`, `.codex-plugin/`) and Copilot / VS Code (Agent Plugins 1.0 `plugin.json`), all generated
by `npm run build` from one source. Agents without plugins link the same skill folders (`npm run link`).

## Alternatives considered
- **A command-line installer only** (like `b2c setup skills`): works for every agent, but no automatic
  updates or hooks. Kept as a possible second front door for agents without plugins.
- **Serve skills through an MCP server:** agents choose skills from skill files, so MCP prompts would be used
  far less reliably, and it needs a server.
- **Skills committed into each client repo:** no sharing across clients and no updates.
- **A hosted platform:** cost, operations, and client credentials in one place.

## Consequences
One versioned unit carries skills, the MCP server, hooks and helpers, and updates through each agent's
plugin manager. Three manifest formats are generated, so their cost is low. Each agent's quirks still apply
(VS Code ignores workspace recommendations, microsoft/vscode#327404; Codex asks to trust plugin hooks).

## Links
Pull requests #20 (Codex), #23 (Copilot / Agent Plugins); `documentation/08-build-and-distribution.md`.
