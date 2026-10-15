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

In a project with a Cartwright profile, the `tools-without-install` skill takes the project's facts from the
profile rather than opening its files: the Node or Python pin, whether it's a B2C Commerce project (where the B2C
CLI matters), and whether spec-kit is set up (which needs uv). See
[Project profile and guardrails](16-project-profile-and-guardrails.md).

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

- **An installed copy at the pinned version or newer is used as is.** One that's **older** than the pin is
  normally skipped: the pinned version runs on demand instead, with a one-line note and the command to
  update the installed copy. If `npx` (B2C CLI) or `uvx` (spec-kit, graphify) is missing, the older installed
  copy runs even without `CARTWRIGHT_PREFER_INSTALLED`; `--plan`, `--check` and the run's stderr explain
  that the runner is missing and cannot fetch the pin.
- **Unknown or unparseable installed versions count as not older**, so those installed copies are used
  too. This does not verify that they meet the pin; `--check` reports their version as `unknown`.
- `CARTWRIGHT_PREFER_INSTALLED=1` requests the installed copy, even an older one (for machines that may
  only run pre-approved installs). `CARTWRIGHT_USE_PINNED=1` takes precedence: it always requests the
  pinned version and reports it unavailable if its runner is missing, rather than using an installed copy.
- **The first run downloads** (around 20 seconds per tool on a normal connection); later runs start in a
  second or two from the cache.

## Staying up to date

```
tool releases a new version
   │  daily upstream check (06:00 UTC) notices it: B2C CLI tags, spec-kit releases, graphify on PyPI
   ▼
standing upstream pull request: lock bumped, plugin/tools/versions.json regenerated,
CHANGELOG entry written, and every pinned tool smoke-tested (✅/❌ in the pull request)
   │  owner merges
   ▼
next weekly release ─▶ everyone's plugin updates ─▶ the next run fetches the new version
```

- **Nothing to do on developer machines.** The new pinned version is fetched on first use after the plugin
  updates; old cached versions are simply not used any more.
- **Installed copies** that fall behind are normally skipped, subject to the exceptions above, and
  `--check` lists the command to update them.
- **A broken release** shows up as a ❌ in the upstream pull request before anything is merged. To stay on
  the previous version, don't merge, or pin back in a small follow-up pull request.
- How the version is checked: `--check` asks each installed tool for `--version` once and caches the answer
  until the tool is reinstalled, so normal runs stay fast.

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
node <plugin>/tools/run.mjs --smoke            # run every pinned version once and confirm it reports that version
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
