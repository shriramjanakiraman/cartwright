# Project profile and guardrails

Agents working in a project guess its stack, commands and rules, and plausible-but-wrong guesses are the main
reason their output is unreliable. Cartwright studies the project once and saves a **profile**: the facts,
each with the file it came from. It also keeps the team's **guardrail settings** and each developer's
**personal file**. Everything ships inside the plugin and runs on Node and git alone. Decision records:
[0011](decisions/0011-project-profile-and-settings.md) (profile and settings) and
[0012](decisions/0012-guardrails-in-agent-hooks.md) (guardrails), both *Proposed*.

> **Status (phase 1, issue #43):** the profiler, the three files and their storage are in place. The
> first-run offer, session-start grounding and the hard blocks are being built in the same phase, and this
> guide grows with them.

## The profiler

`tools/profile.mjs` in the plugin (`scripts/profile.mjs` here). It only reads until the person says yes.

```bash
node "<plugin>/tools/profile.mjs" study       # the proposed profile and settings, as JSON; changes nothing
node "<plugin>/tools/profile.mjs" write --store folder [--protected main,develop] \
     [--generated '<glob>=<regenerate command>' …] [--allow <location>] [--protect <location>] [--client-project yes|no]
node "<plugin>/tools/profile.mjs" diff        # which facts differ from the saved profile, before and after
node "<plugin>/tools/profile.mjs" refresh     # save only those facts
node "<plugin>/tools/profile.mjs" show        # the saved profile, where it's stored, the settings that apply
node "<plugin>/tools/profile.mjs" check       # quick drift and settings check; exit 1 if out of date or broken
```

- `write` needs `--store` (`folder`, `agents-md` or `machine`). It re-runs detection, so it saves what `study`
  showed, and prints `{ store, changed, otherStores }`. Each list option replaces that list (`none` empties
  it). Without one, existing settings keep theirs, and new settings get what `study` proposed.
- `--dir <path>` runs against another folder. Outside a git repository the profiler stops with exit 2.

### How it detects

- **Allowlist only.** It opens `package.json`, `tsconfig.json`, `.nvmrc`, `.node-version`, `.tool-versions`,
  `.python-version`, `pyproject.toml` and `Makefile` (target names only). For everything else it checks
  existence or lists folders (at most 2,000 entries, never inside `node_modules`, `.git` or build
  output). Lockfiles are checked for existence, never opened.
- **Never opens credential files:** `.env*`, `dw.json`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `*.pfx`, `.npmrc`,
  `.netrc`, `credentials*`. Any value that looks like a secret (the same patterns as `npm run scrub`, in
  `secret-rules.mjs`) is saved as `<hidden: looked like a secret>`.
- **Writes nothing while studying.** git runs with `GIT_OPTIONAL_LOCKS=0`, so not even `.git` changes.
- **Reproducible.** Sorted keys, no timestamps, no absolute paths, no plugin version. The same project always
  gives the same bytes, so upgrading the plugin never rewrites a profile on its own.
- **"Not found" instead of a guess.** A fact no rule detected is `{"status": "not found"}`.

### What the profile holds

| Part | Contents |
|---|---|
| `facts` | `platform` (with `flavour`), `languages`, `node`, `python`, `packageManager`, `commands.build`/`test`/`lint`, `otherScripts`, `frameworks`, `layout`, `remoteHost` (the kind of host only, never the URL), `protectedBranchCandidates` |
| `conventions` | `rulesFiles` (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, …), `specKit`, `adrs`, `prTemplate`, `tracker` |
| `guidance` | skills that fit the stack, and skills to avoid (SFRA versus Storefront Next) |
| `suggestions` | generated-file candidates for setup to confirm: from the stack modules, "generated, do not edit" headers in the first lines of tracked files, and tracked build output |

Each command has `run` (how the package manager runs it, for example `pnpm test`), `defined` (the script as the
project wrote it) and `how`: `defined`, or `configured` when it comes from tool configuration such as
`[tool.pytest.ini_options]`.

### Stacks

Detection that depends on the stack lives in one module per stack, listed in `scripts/stacks/index.mjs`:

| Module | Detects |
|---|---|
| `node.mjs` | JavaScript/TypeScript, the Node pin, npm/pnpm/yarn/bun from the lockfile, frameworks and their versions, the project's scripts |
| `python.mjs` | Python, its pin, uv/poetry/pipenv/pip, pytest and ruff configuration, Makefile targets, packages (a minimal TOML reader, no dependency) |
| `sfcc.mjs` | Salesforce B2C Commerce. **Storefront Next** when `package.json` depends on `@salesforce/storefront-next-dev` or has `storefrontNext`; otherwise **SFRA** when `cartridges/*/cartridge/` exists with `paths.base` naming `app_storefront_base`, `sgmf-scripts`, an `app_storefront_base` cartridge, or controllers. Plus cartridges and ISML |

Language modules run first; platform modules can read their facts. To add a stack (#42), add a module, a
fixture under `tests/projects/` and its expected profile in `tests/expected/`.

## The three files

| File | Who owns it | What it holds |
|---|---|---|
| `profile.json` | the team, through pull requests | the detected facts above |
| `settings.json` | the team, through pull requests | the guardrail policy and the confirmed lists |
| `personal.json` | each developer; never committed | additions that only tighten, and preferences |

### Where they're stored

Setup asks. Cartwright looks them up in this order, and the first one found wins:

| Choice | Profile and settings | Personal file | Repo change |
|---|---|---|---|
| `.cartwright/` (default) | `.cartwright/profile.json`, `settings.json`, plus a `README.md` for reviewers | `.cartwright/personal.json`, ignored by `.cartwright/.gitignore` | the folder only; the project's own `.gitignore` is untouched |
| `AGENTS.md` section | one section between `<!-- cartwright:begin … -->` and `<!-- cartwright:end -->`, with a short summary and two fenced blocks (`json cartwright-profile`, `json cartwright-settings`) | on this machine | only that section. Nothing outside the markers changes, including line endings |
| This machine only | `<state>/projects/<key>/` | the same folder | none; teammates' clones are unprofiled |

`<state>` is `$CARTWRIGHT_STATE_DIR` or `~/.cartwright`. `<key>` is the first 16 hex characters of the sha256 of
the project's real path, and the folder's `root` file names the project for people.

### The settings file

```json
{
  "$comment": "Cartwright guardrail settings. Change them in a pull request; …",
  "cartwright": "settings", "version": 1,
  "guardrails": { "protected-branches": true, "secrets": true, "generated-files": true, "destructive-outside-project": true },
  "protectedBranches": ["main", "develop"],
  "generated": [{ "path": "INDEX.md", "regenerate": "npm run build" }],
  "secrets": { "allow": [] },
  "locations": { "allowed": [], "protected": [] },
  "rules": [],
  "clientProject": false,
  "tracks": { "$comment": "Process tracks (quick, standard, full) have no effect yet; …", "enabled": false }
}
```

- `protectedBranches` is the complete list, globs allowed (`release/*`). Without the key, `main` and `develop`.
- `generated` entries are a glob plus the command that regenerates them.
- `secrets.allow` lists paths the team accepts as deliberate fakes. Paths only, no inline markers.
- `locations` entries may use `~` and `${ENV}`; relative ones are from the project root. `protected` wins.
- `rules` are the project's own must-nevers: `{ "id", "message", "shell": "<regex, ≤300 chars>" }` or
  `{ "id", "message", "paths": ["<glob>"] }`.
- `tracks` is reserved for a later release and has no effect.
- Unknown top-level keys only warn ("update Cartwright"). A newer `version`, invalid JSON or a wrong type makes
  the whole file **broken**.

### Broken settings fail safe

If the settings can't be used, all four rules stay on. Then:

- the protected branches are `main`, `develop` and the profile's candidates;
- the generated files are the profile's suggestions;
- the project's own `rules`, `locations.allowed` and `secrets.allow` pause, because broken must never mean
  looser.

`show` and `check` say which file is broken and where (a line and column, or a key path). They never quote the
file's content. `write` won't overwrite a broken file: fix or move it by hand.

### The personal file can only tighten

| Key | How it merges with the team's settings |
|---|---|
| `guardrails.<rule>` | `true` switches a rule on for you; `false` is ignored and reported |
| `protectedBranches`, `generated`, `locations.protected` | added to the team's (for the same generated path, the team's command wins) |
| `rules` | added; a rule reusing a team rule's `id` is ignored and reported |
| `locations.allowed`, `secrets.allow`, `tracks`, `clientProject` | team only; ignored and reported |
| `preferences` | yours alone |

```json
{ "cartwright": "personal", "version": 1, "protectedBranches": ["staging"], "preferences": {} }
```

`show` lists the settings that apply to you (`settings.effective`) and any loosening it ignored
(`settings.loosening`).

## Tests

`npm run e2e:profile` (part of every `npm run test:release` level) runs against a copy of the built plugin. It
turns the fixtures in `tests/projects/` into git repos with a local remote, compares each profile with
`tests/expected/`, and checks the following:

- "not found";
- that no secret value appears anywhere;
- read-only study (file times and the git index unchanged);
- reproducible writes;
- drift and refresh;
- the settings content;
- the personal file;
- all three storage modes;
- broken settings.

After an intended detection change, run `node scripts/e2e-profile.mjs --update-goldens` and review the diff of
`tests/expected/`. The SFRA case uses a tree the test generates until the `zzt-client-test` fixture is reworked
into a real SFRA layout.
