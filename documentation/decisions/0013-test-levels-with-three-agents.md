# 13. Test levels with grounding and guardrail scenarios in three agents

**Status:** Proposed (supersedes 0009 once accepted) · **Date:** 2026-10-10 · **Deciders:** team lead, architect

## Context
ADR 0009 set three levels. Under it:
- `quick` runs no agents and is used for patch releases too;
- Codex, VS Code, Claude Code's trust prompt and Windows are manual checks.

Phase 1 (issue #43) needs more:
- every hard block, its allowed counterpart and the broken-settings case need a deterministic test at `quick` (D41);
- real-agent grounding and guardrail scenarios must run in Claude Code, Codex and Copilot "at every release" (C28,
  Q6).

Codex runs through npx (`@openai/codex`) at a pinned version in an isolated `CODEX_HOME`; no global install.

## Decision
- **`quick`** (feature and bugfix work) stays agent-free. It adds the deterministic profile and guard suites
  (`e2e-profile.mjs`, `e2e-guard.mjs`), run on a copy of the built plugin.
- **`quick`** also checks that the Codex trust hashes match `hooks.json` (`scripts/codex-trust.mjs check`).
- **`minor`** is used for **patch and minor releases**. It adds the phase 1 agent scenarios (grounding: C23–C27;
  blocks: D29, D32–D34, D38, with a no-workaround check for D39 and D41) in **Claude Code, Copilot CLI and Codex**:
  - Copilot is driven through `copilot -p` with the plugin **installed** in an isolated `COPILOT_HOME`. The spike
    showed `--plugin-dir` loads no hooks in Copilot, and that installed plugin hooks do run in `-p`;
  - Codex is driven through `codex exec --json` in an isolated `CODEX_HOME`, with the hooks' trust pre-seeded and
    never `--dangerously-bypass-hook-trust`. The test writes
    `[hooks.state."cartwright@cartwright:hooks/hooks.json:<event>:0:0"] trusted_hash = "sha256:…"` for each hook,
    with the hash Codex computes. `scripts/codex-trust.mjs capture` gets the hashes from Codex's app server
    (`hooks/list`, no model call and no sign-in) whenever `hooks.json` changes, which is rare by design, and stores
    them in `tests/codex-hook-trust.json`. Before the scenarios, the test asks the app server again and fails
    unless every hook is reported trusted. Tests stop the isolated home's Codex app-server daemon before each
    scenario, because it caches the hook configuration. Codex signs in with a copy of the person's
    `~/.codex/auth.json`, deleted at the end of the run;
  - agents run in parallel, one stream (one `agent-e2e.mjs --agent <name>` process) per agent;
  - `agent-e2e.mjs --dry-run` prepares every scenario without calling an agent, so the harness can be checked
    for free.
- **`major`** adds the long setup conversations, including the first run with a real pull request.
- **Manual checks stay** for VS Code, Windows and Claude Code's interactive trust and approval prompts.
- **The report records** each agent CLI's version.

## Alternatives considered
- **Agents at every level, including PR work:** about an hour and several dollars per PR.
- **A smoke subset at a new `patch` level:** cheaper, but patch releases would skip criteria 23–27.
- **Agents only at minor and major:** doesn't meet "at every release".
- **Automating VS Code** through an extension test harness: a new dependency and a lot of upkeep.

## Consequences
- **Per release run:** about 25–30 minutes and about $4–6 of Claude Code usage (about $1.5–2 with a cheaper
  `AGENT_MODEL`), about 26 Copilot premium requests, and $2–4 of Codex usage. Codex and Copilot figures are
  unverified.
- **A Codex CLI install and a paid account** are needed (a cost decision).
- **VS Code** remains a manual check. That is a known shortfall against "each of the three agents".
- **To update:** the tester agent's level table, `test-release.mjs` and the end-to-end guide change.

## Links
ADR 0009 (superseded); issue #43; `documentation/14-end-to-end-test.md`.
