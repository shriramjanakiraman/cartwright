# Build and distribution

Skills are written in `core/` and mirrored in `upstream/`, but users never install those folders directly.
`npm run build` packages them, and the packaged output is committed so the repo itself is the plugin.

## What the build produces

| Output | What it is |
|---|---|
| `plugin/skills/<name>/` | every **active** core skill plus every mirrored official skill, one folder each |
| `plugin/.mcp.json` | the official B2C MCP server, at the pinned version |
| `plugin/licenses/` | each upstream publisher's licence (attribution required by Apache-2.0) |
| `.claude-plugin/marketplace.json` | lets the repo install as a Claude Code plugin marketplace |
| `plugin/.claude-plugin/plugin.json` | the Claude Code plugin manifest (name, version) |
| `plugin/plugin.json`, `plugin/mcp.json` | the manifest and MCP file that GitHub Copilot CLI and VS Code read, in Copilot's own format: it declares `skills`, `hooks` (the same `hooks/hooks.json` Claude Code runs) and `mcpServers` |
| `plugin/.codex-plugin/plugin.json` | the Codex plugin manifest: points at the same `skills/` and `.mcp.json`, plus what the Codex plugin directory shows |
| `.agents/plugins/marketplace.json` | lets the repo install as a Codex plugin marketplace |
| `plugin/tools/` | the helpers the plugin runs with only Node and git: client setup (`setup.mjs`, `kit.mjs`, `registry-core.mjs`, `registry.json`), tools without installing (`run.mjs`, `versions.json`), the project profiler (`profile.mjs`, `stacks/`, `store.mjs`, `settings.mjs`, `secret-rules.mjs`) and the guard (`guard.mjs`, `guard-rules.mjs`, `guard-shell.mjs`; see [the guide](16-project-profile-and-guardrails.md)) |
| `plugin/hooks/hooks.json` | the hooks all three agents run: SessionStart (the setup offer and tools note) and PreToolUse (the guardrails). Each entry's command, matcher and timeout are fixed, because Codex trusts hooks by a hash of the entry; new hooks are appended |
| `INDEX.md` | the human catalogue: every skill, its source, version and status |

Draft and deprecated core skills are left out of the plugin but still listed in `INDEX.md`.

**Never edit these by hand.** Change the source (`core/`, or the lock for upstream) and run:

```bash
npm run build          # regenerate
npm run build:check    # fail if the committed output is stale (CI and the pre-commit hook run this)
```

## How users receive it

- **Claude Code** installs `.claude-plugin/marketplace.json` from the default branch (`main`), which is why
  `main` must always be the released state and stays the default branch.
- **Codex** installs the same plugin through `.agents/plugins/marketplace.json`, which only points at
  `plugin/`. The version is in the Claude Code marketplace entry and in both plugin manifests
  (`plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`), all from `package.json`, so one release updates
  every agent.
- **GitHub Copilot CLI and VS Code** install it from the same marketplace and read `plugin/plugin.json`. It
  must stay in Copilot's own format (no `$schema`) and name its parts: in the Agent Plugins 1.0 format
  (with `$schema`) Copilot loads the skills but no hooks, so the session-start hook never ran (fixed after
  2.1.0). `npm run e2e` checks the manifest, and the `copilot-session-start` agent scenario checks that
  Copilot really runs the hook. VS Code is checked by hand: after a change to this manifest, install the
  plugin in VS Code and confirm a new chat in a fresh git folder gets the `[cartwright]` context.
- **Other agents** get the same `plugin/skills/` folders through `npm run link`, one symbolic link per
  skill, so official skills keep their `references/` and `scripts/` working.

See [Getting started](01-getting-started.md).

## Overlays

Each overlay builds into its own small plugin with `node scripts/build-overlay.mjs ../<code>-cartwright`
(from this repo). It writes the overlay's `plugin/` (with Claude Code, Codex and Copilot manifests), both
marketplaces, `INDEX.md`, and `client-project/`: the kit a lead commits into the client project so the
team gets core and the overlay automatically. The plugin's version comes from the overlay's `overlay.json`, set by its
releases. See [Project overlays](09-project-overlays.md).

## Local checks

```bash
npm run check          # validate + scrub-scan + build:check + the registry check + the workflow temp-file check
npm run validate       # the skill standard only
npm run scrub          # the data-leakage scan only
```

The other places run different sets. The pre-commit hook scans the staged files, and runs validate and the
build check only when `core/` or `upstream/` changed. CI runs validate, the scrub scan, the upstream mirror
check, the build check, the Codex trust-hash check, the profile and guard tests, and a secret scan across history. It doesn't run the
registry check.
