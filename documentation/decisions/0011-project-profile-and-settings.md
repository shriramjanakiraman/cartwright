# 11. A deterministic project profile, team settings and a personal file

**Status:** Proposed · **Date:** 2026-10-10 · **Deciders:** team lead, architect

## Context
Agents guess a project's stack, commands and rules. That guessing is the main reason their output is unreliable
(issue #43). Cartwright is a plugin (ADR 0001): whatever studies a project has to ship inside it and run on Node and
git alone.

The profile must also meet several rules from the brief:
- it never invents a fact (A5) and never exposes a secret (A7);
- it is reproducible (A8);
- studying a project only reads it (A9).

Teams must own the settings through pull requests, a developer may only tighten them (Q2), and some clients refuse a
new folder (Gate 1 decision 3).

## Decision
- **Profiler.** `tools/profile.mjs` is a deterministic detector.
  - It reads an allowlist of manifest files and git refs, and never opens secret files.
  - It records each fact with the file it came from, or "not found".
  - Stack-specific detection lives in modules (`tools/stacks/*.mjs`: node, python, sfcc with the SFRA and Storefront
    Next flavours), so new stacks (#42) are added as modules.
  - The agent presents the result and asks the confirmations, but never writes facts itself.
- **Files.** There are three:
  - `profile.json`: facts, conventions, skill guidance, and suggestions;
  - `settings.json`: the team's guardrail policy and confirmed lists, plus a reserved `tracks` section;
  - `personal.json`: the developer's own file, git-ignored.

  Each is versioned (`version: 1`), written with sorted keys and no timestamps.
- **Storage.** There are three choices. The default is `.cartwright/`, with its own `.gitignore` for the personal
  file. The other two are a marked section in the project's `AGENTS.md`, or this machine only (under
  `$CARTWRIGHT_STATE_DIR` or `~/.cartwright`). In the last two modes, the personal file lives on the machine.
- **Merging the personal file.** It can only add or tighten, through one merge table:
  - lists are unions;
  - switches are OR;
  - it can't allow locations or secrets;
  - it can't override a team rule by `id`.
- **Broken settings.** The confirmed protected branches and generated files live in the settings. If the settings are
  broken, the fallback is `main`, `develop` and the profile's detected candidates (ADR 0012).
- **First run.** The session-start hook offers one combined line: set up / not now (asks again in 7 days) / never
  here. The new `project-profile` skill studies the project, asks, writes after the yes, hands on to `client-setup`
  when the project is for a client, and offers one pull request (the kit's pattern, ADR 0004).
- **Grounding.** The session-start hook prints a compact profile summary, with sources, and the rule that the
  project's own rules files win. It re-runs detection in memory, time-boxed, to report drift once per session.
  `client-setup` and `tools-without-install` read facts from the profile.

## Alternatives considered
- **Agent-driven profiling:** broad, but it can invent facts and can't be reproduced; it costs tokens and may read
  secrets.
- **Keeping the confirmed lists in the profile:** they'd survive broken settings, but that contradicts the brief
  (AC16, Q5).
- **A pointer in `AGENTS.md` for grounding:** it changes the project's file, and Claude Code doesn't read it.
- **Renaming `client-setup` to a combined skill:** renaming a skill is a major release.
- **YAML or TOML formats:** they'd need a parser dependency. JSON is built into Node.

## Consequences
- Client repos gain `.cartwright/` (or an `AGENTS.md` section) next to the kit. Both go through a pull request.
- Detection covers only what the modules encode. Other stacks get "not found" until #42 adds modules.
- Each session spends about 200–400 tokens on grounding.
- A plugin upgrade never rewrites a profile by itself, but improved detection can show up as drift.
- Phase 2 builds on this:
  - employees read the same profile;
  - `guidance` tells them which skills apply;
  - `tracks` becomes active.
- Revisit if detection accuracy on real projects proves poor, or if teams want YAML.

## Links
Issue #43; `documentation/16-project-profile-and-guardrails.md`; ADR 0001, 0002, 0004, 0005, 0010, 0012.
