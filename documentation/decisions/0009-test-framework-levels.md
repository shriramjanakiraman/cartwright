# 9. A test framework with three levels and real agents

**Status:** Superseded by [0013](0013-test-levels-with-three-agents.md) · **Date:** 2026-10-10 · **Deciders:** team lead, architect

## Context
Checks alone didn't prove what a developer gets; a manual live test found a real bug and an agent that
skipped an instruction. Testing needs to be repeatable at a cost that fits the change.

## Decision
`npm run test:release -- --level quick|minor|major`: checks; a bare-machine test of the plugin (`e2e.mjs`);
and real agents driven headless (`agent-e2e.mjs`: Claude Code with the plugin loaded per session, Copilot in
an isolated home), judged on what they did. Agent failures are retried once and reported as flaky. Fixtures
are a made-up client with its own private repos.

## Alternatives considered
- **Manual testing per release:** slow, inconsistent.
- **Mocked agents:** cheap but wouldn't catch real agent behaviour.

## Consequences
Major runs cost a few dollars of agent usage; Codex, Claude Code's trust prompt, VS Code and Windows remain
manual checks. The `tester` agent runs it and investigates.

## Links
`documentation/14-end-to-end-test.md`; pull requests #35, #36.
