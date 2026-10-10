# Project profile and guardrails

Agents working in a project guess its stack, commands and rules, and plausible-but-wrong guesses are the main
reason their output is unreliable. Cartwright studies the project once and saves a **profile**: the facts,
each with the file it came from. It also keeps the team's **guardrail settings** and each developer's
**personal file**. Everything ships inside the plugin and runs on Node and git alone. Decision records:
[0011](decisions/0011-project-profile-and-settings.md) (profile and settings) and
[0012](decisions/0012-guardrails-in-agent-hooks.md) (guardrails), both *Proposed*.

> **Status (phase 1, issue #43):** the profiler, the three files and their storage, and the hard blocks are in
> place. The first-run offer and session-start grounding are being built in the same phase, and this guide grows
> with them.

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

Notes on the storage choices:

- **Markers in `AGENTS.md`** count only as whole lines outside code blocks (fenced, or indented by four spaces),
  so a file that merely mentions them isn't Cartwright storage.
- **An unclosed code fence** in `AGENTS.md` makes `write` stop ("unclosed code fence at line N; close it and run
  again"), because a section appended after it would sit inside the fence. After writing, Cartwright reads the
  section back and fails if it can't find it.
- **The name must be exactly `AGENTS.md`.** With only `Agents.md`, Cartwright neither reads nor writes it, on any
  disk: `write` asks you to rename it (`git mv Agents.md AGENTS.md`), and `show` notes the mismatch.
- **A symlinked file stays a symlink.** For example `AGENTS.md` → `CLAUDE.md`: the section is written into the
  file the link points at. A link that leads outside the project is refused.
- **Writes keep each file's permissions** and replace the file in one step (a temporary file, then a rename).
- **Unreadable storage.** An unreadable `.cartwright/` folder or settings file counts as found, with broken
  settings (stricter, and loud), because the folder is the evidence that the project was profiled. An unreadable
  `AGENTS.md` on its own isn't such evidence: the project stays unprofiled, and `show` and `check` add a note.

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

## Hard blocks (guardrails)

Before Claude Code, Codex or GitHub Copilot runs a tool that can change something (`Bash`, `Edit`, `Write`,
`MultiEdit`, `NotebookEdit`, `apply_patch`, `exec_command`, `create`), the plugin's PreToolUse hook asks
`tools/guard.mjs`. The guard reads the tool call, decides, and either lets it run or stops it **before it runs**,
with a message that names the rule and says what to do instead. Read-only tools never start it. Decision record:
[0012](decisions/0012-guardrails-in-agent-hooks.md).

| Rule | Where it applies | What it stops |
|---|---|---|
| `secrets` | every project | a `git commit` that would record a token or credential |
| `destructive-outside-project` | every project | deleting or overwriting something outside the project, the temporary folder and Cartwright's cache |
| `protected-branches` | once the project has guardrail settings | a `git push` to a protected branch |
| `generated-files` | once the project has guardrail settings | hand-editing a file on the confirmed generated list |
| the project's own `rules` | while the settings are valid | whatever the team listed |
| `guardrail-files` | always; can't be switched off | changing the guardrail settings without the person |

The team can switch the first four off in the settings (`guardrails.<rule>: false`), through a pull request.
The personal file can only switch them on.

**No bypass.** There's no allow-once token, environment variable or inline marker. Every block ends with:
"Don't try another way; if it really must happen, tell the person they can run it themselves."

### `protected-branches`

Every form of push is judged by where it would go:
- `git push origin main`, `HEAD:main`, `+main`, `--force` and `--force-with-lease`;
- deleting (`:main`, `--delete main`);
- a bare `git push`, which goes where `@{push}` says (the upstream and `push.default`);
- `--all` and `--mirror`.

The branches are the settings' `protectedBranches` (globs such as `release/*` work), plus the personal file's.
Tags and other branches go through. A destination hidden in a variable or a command is blocked ("can't tell where
this push goes"), except `$(git branch --show-current)`.

> Cartwright blocked this (protected-branches): it would push to main, a protected branch here
> (.cartwright/settings.json). Push your own branch (git push -u origin <branch>) and open a pull request. Don't
> try another way; if it really must happen, tell the person they can run it themselves.

### `secrets`

At `git commit`, the guard looks at what would be committed:
- the staged changes;
- with `-a` or pathspecs, the matching tracked changes;
- files added earlier on the same line (`git add . && git commit …`).

It scans the added lines with the same patterns as `npm run scrub`: private keys, GitHub, AWS and Slack tokens,
JWTs, quoted secret assignments, and `sk_live_`/`sk_test_`/`npm_`/`AIza`/`glpat-` keys. It also blocks committing
files named like credentials (`.env`, `*.pem`, `*.key`, `id_rsa`…; `.env.example` is fine). Lockfiles, binary
files and the team's `secrets.allow` paths are skipped. The message names the file and line, never the value.

> Cartwright blocked this (secrets): src/config.ts:3 looks like a GitHub token. The value isn't shown. Remove it
> (use an environment variable or the project's secret store), unstage it, and commit again. If it's a deliberate
> test fake, the team can allow that path in the settings through a pull request. …

### `generated-files`

Edits through the agent's tools (`Edit`, `Write`, Copilot's `create`, Codex's `apply_patch`), and shell writes onto
a generated path, are blocked. The shell writes include:
- redirections (`>`, `>>`, here-documents);
- `tee`;
- `sed -i`, `perl -pi` and `awk -i inplace`;
- the destination of `cp`, `mv`, `install`, `ln` and `rsync`;
- `truncate` and `dd of=`;
- `git apply` and `patch`.

Commands inside `sh -c`, `eval` and `$(…)` count too. Reading, `git checkout -- <file>`, `git restore`, deleting,
and running the regenerate command aren't blocked.

> Cartwright blocked this (generated-files): src/generated/api.ts is generated (.cartwright/settings.json:
> src/generated/**). Don't edit it by hand: change its source and run pnpm generate:api. …

### `destructive-outside-project`

The guard blocks deleting (`rm`, `rmdir`, `unlink`, `shred`, `find … -delete`, `rsync --delete`, `mv` away) and
overwriting an **existing** path (redirection, `cp`, `tee`, `sed -i`, an edit) outside the allowed places:
- the project;
- the temporary folder (`$TMPDIR`, `$TMP`, `$TEMP`, `/tmp`, `/var/tmp`);
- Cartwright's cache (the state folder and the agent's plugin data folder);
- the team's `locations.allowed`.

These places are worked out on each call, on each machine. A `locations.protected` entry is blocked even inside the
project. Creating a new file and appending lose no data, so they aren't blocked. A target that depends on an
unknown variable is blocked ("can't tell where this delete points; use an explicit path").

> Cartwright blocked this (destructive-outside-project): it would delete ~/precious, which is outside this
> project, the temporary folder and Cartwright's cache. Work inside the project, or ask the person to run it
> themselves. If the team works there routinely, they can add it to locations.allowed in the settings through a
> pull request. …

### `guardrail-files`

Changing the guardrail settings needs the person's approval at that moment. That covers:
- `.cartwright/settings.json` or `profile.json`, and deleting or moving `.cartwright/`;
- the Cartwright section of `AGENTS.md` (an edit inside it, or any shell write to `AGENTS.md`);
- the machine-mode files;
- running `profile.mjs write` or `refresh`;
- disabling or uninstalling the plugin, or switching its hooks off in an agent's settings file.

The personal file isn't covered: it's the developer's own, and it can only tighten.

The person's yes can't be read from the chat, so the guard uses the agent's own approval prompt where that's
verified to work for a hook. It isn't yet verified for any agent; until it is, the change is blocked, and the
message gives the person the command to run themselves:

> Cartwright blocked this (guardrail-files): it changes the project's profile and guardrail settings, and only the
> person can approve changes to the guardrail settings. Show them the change and give them this command to run in
> their own terminal: node "<plugin>/tools/profile.mjs" write --store folder --protected main --generated none. …

### Broken settings, and the personal file

- **Broken settings.** With unreadable or invalid settings, every block still applies, with the fallback lists
  from [Broken settings fail safe](#broken-settings-fail-safe), and each message adds what's wrong and how to fix
  it.
- **The personal file.** When it tried to switch a rule off, the block says "your personal file tries to switch
  this off; the personal file can only add or tighten rules".

### Why was this blocked?

`node "<plugin>/tools/guard.mjs" explain "<command>"` shows the decision for a shell command in the current
project, with the rule and message, without running it. `guard.mjs status` shows which rules are on here and the
settings they use.

### Limits

These are guardrails, not a complete boundary, as the agent vendors themselves say of hooks.

- **Command matching.** It can't see writes made inside a script or an interpreter (`node -e`, `python -c`,
  `npm run x` that pushes), or a command assembled at run time (`sh -c "$CMD"`). Phase 3's auditor closes the
  loop.
- **Windows.** The hooks run through `sh`, so there are no hard blocks on Windows. The guard does nothing there
  and says so.
- **Codex** runs plugin hooks only after you approve them in `/hooks`. Until then they silently don't run.
  Approving once covers updates, because the hook entries never change.
- **Speed.** About 0.1–0.3 s per guarded tool call (Node starting), measured by the guard test.

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

`npm run e2e:guard` (every level, and CI) runs the cases in `tests/guard-cases.json` against a copy of the built
plugin. That's every block, its allowed counterpart, broken settings, the personal file and a project with its own
git hook, in the payload shapes of Claude Code, Copilot and Codex. Each case runs in its own copy of a fixture
project with a local remote:
- a subset goes through the real hook entry and the `sh` trampoline;
- the rest call the guard in-process.

Allowed pushes and commits are then run, and denied ones must leave the remote unchanged and log exactly one
decision. HOME is a symlink and the temporary folder is moved, to prove that locations are worked out at run
time. The suite also measures p50 and p95 against the budget. To add a case, add an entry to the table.
