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
node "<plugin>/tools/profile.mjs" study       # the proposed profile and settings, and the write command; changes nothing
node "<plugin>/tools/profile.mjs" write --store folder --protected main,develop \
     --generated '<glob>=<regenerate command>' … [--secrets-allow <glob> …] \
     [--allow-location <location> …] [--protect-location <location> …] [--client-project yes|no]
node "<plugin>/tools/profile.mjs" diff        # which facts differ from the saved profile, before and after
node "<plugin>/tools/profile.mjs" refresh     # save only those facts
node "<plugin>/tools/profile.mjs" show        # the saved profile, where it's stored, the settings that apply
node "<plugin>/tools/profile.mjs" check       # quick drift and settings check; exit 1 if out of date or broken
```

- `write` needs `--store` (`folder`, `agents-md` or `machine`). It re-runs detection, so it saves what `study`
  showed. It prints `{ store, changed, otherStores }`. If a store earlier in the lookup order still exists,
  the output also has `active` and a `note`, because that store still takes precedence.
- **New settings need both lists on the command line:** `--protected` and `--generated`, either of which may
  be `none`. The person approves the write command, so what they confirm must be in it. Without them,
  `write` exits 2 and prints the proposal as a ready-to-confirm command (`study` returns it too, as
  `writeCommand`). It also names any suggested generated file that has no known regenerate command, so the
  person can add one or leave it out.
- Each list option replaces that list, and `none` empties it. `--protected` takes a comma-separated list; the
  others repeat. When valid settings already exist, a list that isn't given keeps its saved value. Rule
  switches a later Cartwright added are kept as they are.
- `--dir <path>` runs against another folder. Outside a git repository the profiler stops with exit 2.

### How it detects

- **Allowlist only, inside the project.** It opens `package.json`, `tsconfig.json`, `.nvmrc`, `.node-version`,
  `.tool-versions`, `.python-version`, `pyproject.toml` and `Makefile` (target names only). For everything else
  it checks existence or lists folders (at most 2,000 entries, never inside `node_modules`, `.git` or build
  output). A symlink is followed only if it stays inside the project, and symlinked folders are never entered.
  Lockfiles are checked for existence, never opened.
  A cartridge that is a symlinked folder isn't listed, because symlinked folders are never entered.
- **Never opens credential files:** `.env*`, `dw.json`, `*.pem`, `*.key`, `id_rsa*`, `id_dsa*`, `id_ecdsa*`,
  `id_ed25519*`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `.npmrc`, `.netrc`, `.pgpass`, `credentials*`,
  `secrets.*`, `*.tfvars`. It doesn't search them for headers either, and never suggests them as generated
  files.
- **Hides secret-looking values.** Any value that looks like a secret is saved as
  `<hidden: looked like a secret>`. The patterns (in `secret-rules.mjs`) are those of `npm run scrub` plus
  broader ones for copied values: passwords in URLs, Bearer tokens, `KEY=`/`TOKEN=`/`SECRET=`/`PASSWORD=`
  assignments, `mysql -p…`, and `sk_live_`, `npm_` and `AIza` keys.
- **Exact names.** A file counts only under its exact name, taken from its folder's listing. On a
  case-insensitive disk `claude.md` isn't `CLAUDE.md`, so a project profiles the same way on macOS and Linux.
- **Pins must look like versions.** A Node or Python pin that doesn't look like one is "not found". An
  `engines` or `requires-python` range is recorded as `kind: "range"`, and a pin as `kind: "pinned"`.
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
`[tool.pytest.ini_options]`. When the package manager isn't found, a script is recorded with `defined` and no
`run`: Cartwright doesn't assume npm. A generated-file suggestion then has no regenerate command.

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

In `AGENTS.md`, a marker counts only as a whole line outside code fences, so a file that merely mentions
the markers isn't Cartwright storage. A symlinked `AGENTS.md` (for example to `CLAUDE.md`) stays a symlink: the
section is written into the file it points at, and a link that leads outside the project is refused. A folder or `AGENTS.md` that exists but can't be read counts as found,
with broken settings (stricter, and loud), never as "unprofiled".

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

`npm run e2e:profile` (part of every `npm run test:release` level, and of CI on every pull request) runs against
a copy of the built plugin. It
turns the fixtures in `tests/projects/` into git repos with a local remote, compares each profile with
`tests/expected/`, and checks the following:

- "not found";
- that no secret value appears anywhere, in the shapes people paste into scripts;
- read-only study (every file and `.git` byte for byte, also on a profiled project with a stale index);
- reads that stay inside the project (symlinks), exact file names, and version-shaped pins;
- reproducible writes;
- drift and refresh;
- the settings content;
- the personal file;
- all three storage modes, `AGENTS.md` line-ending edge cases, and markers merely mentioned in prose;
- broken settings, including unreadable files and folders.

After an intended detection change, run `node scripts/e2e-profile.mjs --update-goldens` and review the diff of
`tests/expected/`. The fixtures are SFRA, Storefront Next, TypeScript/pnpm, Python and an unknown stack, all
made up.
