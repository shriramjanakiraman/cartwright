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
- **Other agents** get the same `plugin/skills/` folders through `npm run link`, one symbolic link per
  skill, so official skills keep their `references/` and `scripts/` working.

See [Getting started](01-getting-started.md).

## Overlays

Each overlay builds into its own small plugin with `node scripts/build-overlay.mjs ../<code>-agent-skills`
(from this repo). It writes the overlay's `plugin/`, `.claude-plugin/marketplace.json`, `INDEX.md` and
`client-project-settings.json`. The plugin's version comes from the overlay's `overlay.json`, set by its
releases. See [Project overlays](09-project-overlays.md).

## Local checks

```bash
npm run check          # validate + scrub-scan + build:check, the same as the pre-commit hook and CI
npm run validate       # the skill standard only
npm run scrub          # the data-leakage scan only
```
