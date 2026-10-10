---
name: tools-without-install
description: "Run the B2C CLI (b2c), spec-kit (specify) and graphify without installing them, at the versions the team has tested. Use when a skill or the developer says to run b2c, specify or graphify and the command isn't installed (\"command not found\"), when working on a machine that has none of these tools, when the session-start notice lists tools as not installed, or before suggesting a global install of any of them. Also checks the prerequisites (Node, uv) and explains what each tool would run as."
owner: shriramjanakiraman
version: 0.2.0
status: active
applies-to: [any]
depends-on: [tool:node]
agents-tested: [claude-code]
last-reviewed: 2026-10-10
---

# tools-without-install

Lets a developer use the B2C CLI, spec-kit and graphify, and every skill that calls them (ours and
Salesforce's official ones), on a machine where none of them is installed. The helper `run.mjs` uses an
installed copy when there is one; otherwise it fetches the version pinned by the library on first use
(`npx` for the B2C CLI, `uvx` for spec-kit and graphify) and caches it.

## When to use

- A command `b2c …`, `specify …` or `graphify …` fails with "command not found", or the session-start notice
  says one of them isn't installed.
- Another skill's step says to install one of these tools before using it.
- A developer asks what they need on a new machine to use the skills.
- **Skip** when the tool is installed and working, or when the developer explicitly wants a permanent
  install (Step 4).

## Steps

The helper's full path is in the session-start notice. Otherwise it's `tools/run.mjs` in the plugin's folder
(two folders up from this skill's own `SKILL.md`), or `scripts/run.mjs` in a clone of the Cartwright library.

### Step 0 — Fast check

If the project has a Cartwright profile, take its facts from there instead of opening `.nvmrc`, `package.json` or
`pyproject.toml` yourself:

```bash
node <profile.mjs> show      # profile.mjs sits next to run.mjs
```

- **The pins:** `facts.node` and `facts.python` give the pin (`kind: "pinned"`) or the range (`kind: "range"`) the
  project asks for, with its source.
- **The tools that matter:** `facts.platform` says whether it's a Salesforce B2C Commerce project, where the B2C
  CLI matters. `conventions.specKit` says whether spec-kit is set up, which needs uv. Without spec-kit or graphify
  in use, uv isn't needed.
- **Not found** means the profile doesn't know; say so rather than guessing.

Then check the tools:

```bash
node <run.mjs> --check
```

It lists each tool as `installed <version>`, `runs on demand via npx|uvx`, or `NOT RUNNABLE (needs …)` with
the fix, plus the pinned version. An installed copy **older** than the pinned version is skipped and the
pinned one runs instead; `--check` shows the command to update the installed copy. Offer it, but don't run it
without a yes. If everything is installed or runnable, go straight to Step 1.

### Step 1 — Run the tool through the helper

Use exactly the arguments the skill or the developer gave, with the helper in front:

| Instead of | Run |
|---|---|
| `b2c sandbox list` | `node <run.mjs> b2c sandbox list` |
| `specify init --here --integration <agent>` | `node <run.mjs> specify init --here --integration <agent>` |
| `graphify <args>` | `node <run.mjs> graphify <args>` |

The first run of each tool downloads it (seconds to a minute); later runs use the cache. Say so the first
time, so a short pause isn't mistaken for a hang. Exit codes and output are the tool's own.

To see the exact command without running it: `node <run.mjs> --plan <tool> <args>`.

### Step 2 — A prerequisite is missing

- **`npx` missing** (B2C CLI): Node.js 20+ isn't installed. Tell the developer; it's needed for the plugin's
  helpers anyway.
- **`uvx` missing** (spec-kit, graphify): uv isn't installed. It's one small program that also provides
  Python when needed. Show the install command from `--check` and **ask before running it**. After installing,
  the developer may need to open a new terminal (or the agent may need restarting) so it's on the PATH.

### Step 3 — The download is blocked

- **Agent sandbox:** some agents (Codex by default) run commands without network access. The first run needs
  network: ask the developer to approve it when the agent prompts, then it's cached.
- **Company or client network:** if the public registries are blocked, use the organisation's mirror the
  standard way: `npm_config_registry` for the B2C CLI; `UV_DEFAULT_INDEX` (or `UV_INDEX_URL`) for graphify.
  spec-kit is fetched from GitHub, so GitHub must be reachable.
- If it still fails, show the error and stop; don't fall back to installing something else.

### Step 4 — Installing permanently (only if asked)

If the developer uses a tool every day and wants it installed, `--check --json` gives the exact command for
the pinned version (`installPermanently`). The helper always prefers an installed copy, so nothing else
changes. Ask before installing anything.

## How to verify

- `node <run.mjs> --check` shows every tool as installed or runnable on demand.
- `node <run.mjs> b2c --version` (or `specify --version`, `graphify --help`) prints the tool's own output.
- `node <run.mjs> --smoke` confirms each pinned version runs and reports that version.

## Constraints

- Never install a tool, uv or Node globally without the developer's explicit yes.
- Use the pinned versions; don't switch to `@latest` to get past an error.
- Keep the tool's own arguments unchanged; the helper only adds what's needed to run it.
- Credentials and instance settings stay with the tool (for example the B2C CLI's own configuration); the
  helper never reads or stores them.

## References

- The *Run tools without installing* guide in the Cartwright library's `documentation/` folder.
- `upstream.lock.json` in the library: where the pinned versions come from.
