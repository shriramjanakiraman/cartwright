# 12. Hard-block guardrails in the agents' PreToolUse hooks

**Status:** Proposed · **Date:** 2026-10-10 · **Deciders:** team lead, architect

## Context
Nothing stops an agent from pushing to a protected branch, committing a secret, hand-editing generated files or
deleting things outside the project. This repo's own git hooks and CI don't reach consumers, and phase 1 adds no git
hooks to consumer repos (Q3).

Claude Code, Codex and GitHub Copilot can each deny a tool call from a plugin's PreToolUse hook, with exit code 2
and a reason. The coordinator checked this in the vendor docs on 2026-10-10.

A spike the same day confirmed it for **Claude Code 2.1.295** and **Copilot CLI 1.0.83**: `git push origin main` and an
edit to a listed file were denied, and the agents didn't work around it. It confirmed it for **Codex CLI 0.162.1** too,
once its hooks are trusted: push and `apply_patch` were denied, and the agent didn't work around them. Copilot only loads a plugin's hooks when the
plugin's root `plugin.json` is its legacy manifest declaring `"hooks"`; it then reads the Claude-format file. Our
Agent Plugins 1.0 root manifest loaded none, so the session-start hook has never run in Copilot (a separate bugfix).
Copilot's Edit payload uses `path`, `old_str` and `new_str`. Plugin hooks run in headless `copilot -p`.

Some limits remain:
- Codex runs plugin hooks only after the user trusts them, and without a warning in headless `codex exec` when they
  aren't; it calls hooks "a guardrail, not a complete enforcement boundary".
- Copilot fails closed on hook errors and fails open on timeouts.
- Whether VS Code can deny is unverified.

The team lead's decisions shape the rules:
- universal rules everywhere, the others once a project has settings (Q1);
- only the team's committed settings loosen a rule, and there is no bypass (Q2);
- block deletions outside the project, with locations resolved at run time (Q9);
- block pushes but not merges (Q10);
- fail safe and loudly when the settings are broken (Q11).

## Decision
- **One guard.** `tools/guard.mjs` (adapter) and `tools/guard-rules.mjs` (pure rules) are called from one PreToolUse
  hook in `hooks/hooks.json`, shared by all three agents.
  - The root `plugin.json` is written in Copilot's legacy format and declares that hooks file. This comes from a
    separate bugfix, and phase 1 depends on it. A packaging check keeps it from regressing.
  - The matcher covers write-capable tools only.
  - The hook command is a byte-stable `sh` trampoline. It tries the plugin-root variables (`CLAUDE_PLUGIN_ROOT`,
    `COPILOT_PLUGIN_ROOT`, `PLUGIN_ROOT`), then a cached path, and exits 0 if node or the plugin is missing. Codex
    sets `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`, and its data folders are `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA`.
  - The `hooks.json` entries (command, matcher, timeout) and their order within each event are fixed; all logic
    lives in the scripts. Codex's trust hash covers the entry, not the script, so script changes and version bumps
    keep trust, while changing an entry or inserting or reordering groups asks every Codex user again. New hooks
    are appended.
  - The decisions are allow (exit 0) and deny (exit 2 with the reason). "Confirm" uses the agent's native approval
    prompt where one is verified, and otherwise becomes a deny that tells the person to run the command.
- **Payloads.** Each agent's payload is normalised into shell and edit actions:
  - `tool_name`/`tool_input`, with Claude's `file_path`/`old_string`/`new_string` and Copilot's
    `path`/`old_str`/`new_str`;
  - Copilot's camelCase `toolName`/`toolArgs`;
  - Codex: `tool_name` `Bash` or `apply_patch`; the patch text, with absolute paths (`*** Update File: <abs path>`),
    is in `tool_input.command`.
  - A small POSIX shell parser recurses into `sh -c`, `eval`, `$(…)` and `xargs`, and expands git aliases.
- **The rules:**

  | Rule | Scope |
  |---|---|
  | `secrets` (at commit; patterns shared with `scrub-scan` in `secret-rules.mjs`) | universal |
  | `destructive-outside-project` (deleting, or overwriting an existing path, outside the project, the temporary folders, Cartwright's cache and the agents' plugin-data folders, all resolved per call; creating new files and appending outside the project are allowed, G10) | universal |
  | `protected-branches` (every push form, including a bare push through `@{push}`) | when settings exist |
  | `generated-files` (edit tools **and** shell writes: redirections including `>>`, `tee`, `cp`/`mv` destinations, `sed -i` and other in-place edits, `git apply`; each message gives the entry's regenerate command) | when settings exist |
  | the project's own rules | when settings are valid |
  | `guardrail-files`, a built-in rule that can't be switched off | always |

  `guardrail-files` makes these need the person's approval (G11):
  - every change to the settings, the profile or the `AGENTS.md` section, and the machine-mode files; deleting or
    moving `.cartwright/`; `profile.mjs write` and `refresh`;
  - git's file-level changes to them (`git rm`, `git mv`, `git checkout --`, `git restore`); `chmod`, `chown`,
    `chgrp`, `chflags`, `setfacl` and `xattr` on them; and sweeping commands (`git stash`, `git clean -f`,
    `git reset --hard`, `git checkout -f`) only when they'd destroy uncommitted guardrail content;
  - disabling, uninstalling or removing the plugin, and `plugin marketplace remove`;
  - switching its hooks off in an agent's settings file (judged by what an edit writes), and any shell write, move or
    delete of `.claude/settings*.json`, `.github/copilot/settings.json` or `.codex/config.toml`.
  - interpreter scripts (python, node, deno, bun, ruby, perl, php) whose readable text names one of these paths and
    contains a write operation: literal `-c`/`-e` text, here-documents, literal pipes, or a script the agent wrote
    (earlier on the line, or a file of at most 64 KB in the project or temp, trusted only when it's identical to its
    version on a protected branch's remote). Literal interpreter
    text that writes a generated file is denied under `generated-files`.

  The guard only sees the agent's own tool calls, so a developer turning Cartwright off themselves (in their
  terminal, the agent's menu, or by editing the file by hand) is never blocked.
- **Broken settings.** All four rules stay on, using `main`, `develop` and the profile's detected candidates. The
  project's own rules and allowlists pause. The session-start hook says so, and so does every block.
- **No exits other than 0 and 2.** Internal errors deny only actions that matched a rule family. An internal deadline
  of 5 s keeps the guard clear of Copilot's fail-open timeout.
- **Windows** is a documented gap: the guard does nothing there.
- **The decision log.** An opt-in log (`CARTWRIGHT_GUARD_LOG`, with no command text) serves the tests now and phase
  3's auditor later.

## Alternatives considered
- **Git hooks in consumer repos:** ruled out (Q3). They can be skipped with `--no-verify`, and they'd change the
  consumer's repo.
- **One script per agent:** duplicated logic. The payload differences are small enough to normalise.
- **JSON deny output per agent:** the formats differ slightly. Exit code 2 is documented by all three.
- **Trusting a chat "yes" for settings changes:** a hook can't verify chat. Native approval or "the person runs it"
  can be trusted.
- **Blocking all four rules in every project:** a major release (tracked in #41).

## Consequences
- **Latency:** about 0.1 s per guarded tool call (Node start-up). The guard test reports p50 and p95, and fails
  when the median of paired differences (with and without the guard) is more than twice the budget, so a busy
  machine doesn't fail it.
- **Coverage:** command matching can't see actions hidden in scripts. The docs say so, and phase 3's auditor closes
  the loop.
- **Codex (verified on 0.162.1):** grounding and blocks work only after the user trusts the hooks in `/hooks`; until
  then they silently don't run. Codex asks once, for both hooks together: the new PreToolUse hook and the updated
  SessionStart entry, finalised at the end of phase 1.
- **VS Code:** to check by hand once the manifest fix is in. Any gap goes to the team lead.
- **"Ask" support** in each agent is still to check interactively. Until it's verified for an agent, "confirm" there
  is a deny with "the person runs it".
- **Copilot on Windows** without `sh` needs checking, because it fails closed.
- **The spike is done** for Claude Code, Copilot CLI and Codex (G1); VS Code is checked by hand at the end of phase 1.
  Revisit if a vendor changes its hook contract, or if false positives push teams to switch rules off.

## Links
Issue #43; #41; `documentation/16-project-profile-and-guardrails.md`; ADR 0001, 0007, 0010, 0011.
