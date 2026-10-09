# Run tools without installing

Many skills, ours and Salesforce's official ones, run command-line tools: the **B2C CLI** (`b2c`),
**spec-kit** (`specify`) and **graphify**. With Cartwright installed, a developer doesn't have to install any
of them first. The plugin runs them on demand, at the versions the team has tested.

## What a developer needs

| Needed for | Install once | Notes |
|---|---|---|
| everything | **Node.js 20+** and **git** | Node includes `npx`; the plugin's helpers run on Node |
| spec-kit, graphify | **uv** (one small program) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` (macOS/Linux), `brew install uv`, or the PowerShell installer on Windows. It also provides Python when graphify needs it. |

Nothing else: no global `npm install`, no `pip install`, no `uv tool install`.

## How it works

```
skill says "b2c sandbox list"
        │
        ▼
node <plugin>/tools/run.mjs b2c sandbox list
        │
        ├─ b2c installed? ──yes──▶ run the installed copy
        │
        └─ no ──▶ npx --package @salesforce/b2c-cli@<pinned> b2c sandbox list
                  (downloads on first use, then cached)
```

| Tool | Command | Runs on demand via | Version |
|---|---|---|---|
| B2C CLI | `b2c` | `npx`, npm package `@salesforce/b2c-cli` | pinned as `b2c-cli` in `upstream.lock.json` |
| spec-kit | `specify` | `uvx`, from the spec-kit GitHub repo at the pinned tag | pinned as `spec-kit` |
| graphify | `graphify` | `uvx`, PyPI package `graphifyy` | pinned as `graphify` |

- **An installed copy always wins.** A developer, or a locked-down machine with approved versions, can still
  install tools the normal way. Set `CARTWRIGHT_USE_PINNED=1` to use the pinned version anyway.
- **The pinned versions move with the daily upstream check** ([Official skills](07-official-skills-upstream.md)),
  so everyone runs the version that was reviewed and released, not whatever is newest that day.
- **The first run downloads** (around 20 seconds per tool on a normal connection); later runs start in a
  second or two from the cache.

## How agents know to use it

- **The session-start hook** checks, in milliseconds, which of the three commands aren't installed. If any
  are missing, it tells the agent to run them through the helper instead of installing them. That works for
  Salesforce's official skills too, which simply say `b2c …`.
- **The `tools-without-install` skill** covers the rest: checking prerequisites, a missing uv (it asks
  before installing anything), blocked downloads, and installing permanently if the developer wants that.

## Commands

```bash
node <plugin>/tools/run.mjs --check            # what's installed, what runs on demand, what's missing
node <plugin>/tools/run.mjs --check --json     # the same, plus the exact command to install each permanently
node <plugin>/tools/run.mjs --plan specify init --here    # the command it would run, without running it
node <plugin>/tools/run.mjs b2c --version      # run a tool
```

In a clone of the library, the same helper is `scripts/run.mjs`.

## When a download is blocked

- **Agent sandboxes:** some agents (Codex by default) run commands without network access, so the first run
  needs the developer to approve network use when the agent asks. After that the cache is used.
- **Company or client networks:** point the tools at the organisation's mirror the standard way:
  `npm_config_registry` for the B2C CLI, `UV_DEFAULT_INDEX` (or `UV_INDEX_URL`) for graphify. spec-kit comes
  from GitHub.
- **Policies that forbid fetching packages on demand:** install the pinned versions once
  (`--check --json` lists the commands); the helper then uses those.

## For skill authors

Don't tell developers to install these tools. Call them as usual (`b2c …`, `specify …`, `graphify …`); the
hook and the `tools-without-install` skill handle a missing tool. To add another tool, add it to `TOOLS` in
`scripts/run.mjs` and pin its version as a source in `upstream.lock.json`.

## Files

| File | Role |
|---|---|
| `scripts/run.mjs` (`plugin/tools/run.mjs`) | the helper |
| `plugin/tools/versions.json` | the pinned versions, generated from `upstream.lock.json` by `npm run build` |
| `core/tools-without-install.md` | the skill |
| `scripts/setup.mjs` (`hook`) | the session-start note about missing tools |
