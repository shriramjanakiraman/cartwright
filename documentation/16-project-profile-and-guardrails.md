# Project profile and guardrails

Agents working in a project guess its stack, commands and rules, and plausible-but-wrong guesses are the main
reason their output is unreliable. Cartwright studies the project once and saves a **profile**: the facts,
each with the file it came from. It also keeps the team's **guardrail settings** and each developer's
**personal file**. Everything ships inside the plugin and runs on Node and git alone. Decision records:
[0011](decisions/0011-project-profile-and-settings.md) (profile and settings) and
[0012](decisions/0012-guardrails-in-agent-hooks.md) (guardrails), both *Proposed*.

> **Status (phase 1, issue #43):** the profiler, the three files and their storage, the first-run offer, grounding
> and drift at session start, and the hard blocks are in place. This repo uses its own profile and settings, and the
> overlay template ships starter settings. The real-agent scenarios come next in the same phase.

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
- `check` exits 1 when the profile is out of date or unreadable, or the settings are broken. It exits 0 for a
  project that isn't profiled (`profiled: false`) and for a profile with no settings file (`settings: "none"`).
  In that last case the output adds a `note`: the protected-branch and generated-file rules are off until
  settings exist. Missing settings aren't broken settings, so they don't fail safe.
- `--dir <path>` runs against another folder. Outside a git repository the profiler stops with exit 2.

### How it detects

- **Allowlist only, inside the project.** It opens `package.json`, `tsconfig.json`, `.nvmrc`, `.node-version`,
  `.tool-versions`, `.python-version`, `pyproject.toml` and `Makefile` (target names only). For everything else
  it checks existence or lists folders (at most 2,000 entries, never inside `node_modules`, `.git` or build
  output). A symlink is followed only if it stays inside the project. A symlinked folder met while listing is
  never entered, so a cartridge that is a symlinked folder isn't listed. A folder the profiler starts listing from
  (such as `cartridges/`) is entered even when it's a symlink, as long as it leads to a place inside the project.
  Lockfiles are checked for existence, never opened.
- **One search across tracked files.** To suggest generated files, it runs `git grep` for "generated, do not
  edit" headers over the tracked files (credential files and lockfiles excluded), and keeps only file names
  whose match is in the first lines. The matching text isn't kept.
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
  `engines` or `requires-python` range is recorded as `kind: "range"`, and a pin as `kind: "pinned"`. A Node
  pin that names a release line instead of a version (`lts/*`, `lts/iron`, `node`, `stable`, `latest`) is
  recorded as `kind: "alias"`, because what it means changes over time.
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

Each command has `run` (how the package manager runs it, for example `pnpm test`) and `how`: `defined` for a
script the project wrote, or `configured` when it comes from tool configuration such as
`[tool.pytest.ini_options]` or a Makefile target. A Node package script also has `defined` (the script as the
project wrote it). When the package manager isn't found, a script is recorded with `defined` and no `run`:
Cartwright doesn't assume npm. A generated-file suggestion then has no regenerate command.

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
- **An unclosed code fence** anywhere in `AGENTS.md` makes `write` stop ("unclosed code fence at line N; close it
  and run again"), because it would swallow the section or what follows it. After writing, Cartwright reads the
  section back and fails if it can't find it.
- **The name must be exactly `AGENTS.md`.** With only `Agents.md`, Cartwright neither reads nor writes it, on any
  disk: `write` asks you to rename it (`git mv Agents.md AGENTS.md`), and `show` notes the mismatch.
- **A symlinked file stays a symlink.** For example `AGENTS.md` → `CLAUDE.md`: the section is written into the
  file the link points at. A link that leads outside the project is refused, and so is a `.cartwright` folder
  that is a symlink to a folder outside the project.
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

`show` and `check` say which file is broken and where (a line and column, the line where a file ends too early,
or a key path). They never quote the file's content. `write` won't overwrite a broken file: fix or move it by hand.

### The personal file can only tighten

| Key | How it merges with the team's settings |
|---|---|
| `guardrails.<rule>` | `true` switches a rule on for you; `false` is ignored, and reported when the team's rule is on (when the team already switched it off, there's nothing to loosen) |
| `protectedBranches`, `generated`, `locations.protected` | added to the team's (for the same generated path, the team's command wins) |
| `rules` | added; a rule reusing a team rule's `id` is ignored and reported |
| `locations.allowed`, `secrets.allow`, `tracks`, `clientProject` | team only; ignored and reported |
| `preferences` | yours alone |

```json
{ "cartwright": "personal", "version": 1, "protectedBranches": ["staging"], "preferences": {} }
```

`show` lists the settings that apply to you (`settings.effective`) and any loosening it ignored
(`settings.loosening`).

## First run: the setup offer

In a project that isn't set up, the session-start hook tells the agent to open its first reply with one line:

> Cartwright can study this project (read-only) and save a profile so I use its real commands and rules, and connect
> it to a client's project skills if it's for a client. Reply set up, not now, or never here.

- **"set up"** starts the `project-profile` skill:
  1. it studies the project and shows what it found, with sources;
  2. it asks where to keep the profile and confirms the protected branches, the generated files (with their
     regenerate commands), the locations, and whether the project is for a client;
  3. it shows the exact `profile.mjs write` command. Writing is a guardrail change, so the person approves it in the
     agent's prompt, or runs it themselves;
  4. for a client, it hands on to `client-setup` (lookup, access, kit);
  5. it offers one pull request, with the project's PR template.
- **"not now"** asks again after 7 days.
- **"never here"** never asks again in that project, and changes nothing in it.

If the client is already known (the kit is there, the settings say `clientProject: false`, or "no client" or
"done" was answered), the line leaves out the client part. A profiled project with no client recorded is asked only
*"Is this project for a client?"*, and one whose settings say `clientProject: true` but has no kit is offered to be
connected to the client's project skills. The library and overlay repos are never offered setup. The full table is in
[Client setup](12-client-setup.md).

## Grounding and drift at session start

Wherever a profile exists, in any of the three storage choices, each session starts with a short summary the agent
uses instead of guessing:

```
[cartwright] Project profile (.cartwright/profile.json). Use these facts instead of guessing. If AGENTS.md, CLAUDE.md
or .cursor/rules say otherwise, follow them. A fact marked "not found" isn't known: say so, don't invent it.
- Platform: Salesforce B2C Commerce, SFRA (package.json#paths.base). Prefer b2c-controllers, b2c-forms, b2c-isml; don't use sfnext-* skills
- Languages: JavaScript (package.json), ISML (…) · Node 18.19.0 (.nvmrc) · Python not found · package manager npm (package-lock.json)
- Build: npm run build (package.json#scripts.build) · Test: npm test (package.json#scripts.test) · Lint: not found
- Layout: cartridges app_sample, int_sample_payments (cartridges/)
- Rules files: AGENTS.md · PR template: .github/pull_request_template.md · Decision records: not found · Tracker: not found
- Guardrails: protected develop, main; generated cartridges/*/cartridge/static/default/js/** (regenerate: npm run compile:js). …
Full profile: node "<plugin>/tools/profile.mjs" show --json
```

- **Drift.** The hook re-detects the facts in-process (it never starts `profile.mjs check`). The check is
  time-boxed to 120 ms and skipped silently if it takes longer. When a fact changed since the profile was saved,
  the summary marks it `[out of date]`, and the agent is asked to mention it once in the session and offer a
  refresh. It's mentioned again in later sessions until the profile is refreshed (`project-profile` skill:
  `profile.mjs diff`, then `refresh` after a yes).
- **Guardrail health.** The hook also says, once:
  - when the settings are broken ("… can't be used: … Built-in protections are on and the project's own rules are
    paused");
  - when the personal file tries to loosen team rules;
  - when the profile is stored in more than one place;
  - when the guardrails can't run in this agent: on Windows, without node on the hooks' PATH, or when the guard
    can't be found.
- **The plugin-root cache.** The hook records its plugin folder in `<state>/plugin-root`, rewritten only when it
  changes, so the guard hook can find the plugin in an agent that sets no plugin-root variable.
- **For other skills.** `setup.mjs status` includes `profile`: where it's stored, the settings' state, the host
  (`remoteHost`), the PR template, whether it's for a client, and the default branch. `client-setup` and
  `tools-without-install` use it instead of asking or opening the project's files.
- **Budget.** The whole session start stays at about a quarter of a second and makes no network access. The
  profile test measures what the hook adds to starting Node.

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

**How commands are read.** The guard reads a command line the way a shell would, without running it. It
follows:
- quoting, `;`, `&&`, `||`, pipes and newlines, and the commands inside `if`/`for`/`while`/`case` and function
  bodies;
- variables set earlier on the line, `cd` and `pushd`;
- wrappers such as `env`, `sudo`, `xargs`, `timeout`, `nice`, `npx`, `watch`, `script` and `coproc`;
- commands inside `$(…)`, backticks, `sh -c` (and `bash`, `zsh`, `fish`…), `eval` with known text, a here-string
  or here-document fed to a shell, `echo …| sh`, `find -exec`, `git rebase -x` and `git submodule foreach`;
- git aliases: configured ones, ones given with `-c`, and ones set earlier on the line.

What `echo` or `printf` feeds a shell is worked out the way the shell would print it:
- `printf` with its real rules: `%s`, `%b`, `%c`, `%d`/`%i`/`%u`/`%x`/`%o`, `%%`, flags, width and precision, and
  the format reused until the arguments run out;
- backslash escapes (`\NNN`, `\0NNN`, `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\c`). Shells and versions read these
  differently (bash's `echo -e`, `printf` and `%b` each differ, and `sh`, `zsh` and `dash` decode `echo` without
  `-e`), so every reading is checked, and any of them being blocked blocks the command.

Anything it can't work out exactly is blocked when it's fed to a shell ("what this shell would run can't be worked
out exactly"): a `printf` conversion it doesn't render, such as `%f`, or a `$'…'` that shells read differently. A
`$'…'` like that elsewhere, as a branch for example, counts as unknown.

Paths are followed through symlinks when the path goes through the link (a trailing `/`, a glob under it, or a
write onto it), and compared in the disk's own letter case. A symlink made earlier on the same line
(`ln -s .cartwright l; rm l/settings.json`) is followed the same way by every rule that judges paths. A command
nested more than six levels deep is blocked as too deep to check.

### `protected-branches`

Every form of push is judged by where it would go:
- `git push origin main`, `HEAD:main`, `+main`, `--force`, `--force-with-lease` and `--repo=origin main`;
- wildcard refspecs such as `refs/heads/*:refs/heads/*`, and `:` or `push.default=matching`, which push every
  matching branch;
- deleting (`:main`, `--delete main`);
- a bare `git push`, which goes where `@{push}` says (the upstream and `push.default`), or where the remote's push
  refspec says (from the repo's config, `-c remote.<r>.push`, or `git config` earlier on the line);
- `--all` and `--mirror`;
- `git subtree push <repo> <branch>`, and `gh api` changing `…/git/refs/heads/<branch>` (PATCH, POST, PUT,
  DELETE, also written `-XPATCH`; fields with no method mean POST).

Git configuration that changes where a push goes (`-c`, `--config-env`, `GIT_CONFIG_*`, an `include.path`, or
`git config`, `git branch -u` and `git remote add`/`set-url` earlier on the line) is followed when its value is
known. When it isn't, the push is blocked: "can't tell where this push goes".

Merging (`gh pr merge`, a merge in the GitHub UI) isn't blocked; that's for the phase 3 auditor.

The branches are the settings' `protectedBranches` (globs such as `release/*` work), plus the personal file's.
Tags and other branches go through. A destination hidden in a variable or a command is blocked ("can't tell where
this push goes"), except `$(git branch --show-current)`.

> Cartwright blocked this (protected-branches): it would push to main, a protected branch here
> (.cartwright/settings.json). Push your own branch (git push -u origin <branch>) and open a pull request. Don't
> try another way; if it really must happen, tell the person they can run it themselves.

### `secrets`

At `git commit`, the guard looks at what would be committed:
- the staged changes, or with pathspecs only the files they name (`git commit -- safe.txt` doesn't look at an
  unrelated staged file, unless `--include` is given);
- with `-a`, the tracked changes too;
- files added earlier on the same line (`git add . && git commit …`).

File names come from the full list of what would be committed, so an empty `.env` is still caught.

It scans the added lines with the same patterns as `npm run scrub`: private keys, GitHub, AWS and Slack tokens,
JWTs, quoted secret assignments, and `sk_live_`/`sk_test_`/`npm_`/`AIza`/`glpat-` keys. It also blocks committing
files named like credentials (`.env`, `dw.json`, `*.pem`, `*.key`, `id_rsa`, `*.jks`…; `.env.example` is fine).
When the files can't be known (a variable, a command or `xargs`), the commit is blocked: "name the files
explicitly". Lockfiles, binary
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
- the destination of `cp`, `mv`, `install`, `ln` and `rsync` (also `--target-directory=`);
- `truncate`, `dd of=`, `curl -o`, `sort -o`, and `tar -x -C <folder>`;
- `prettier --write` and `eslint --fix` on generated paths;
- `git apply` and `patch`.

Commands inside `sh -c`, `eval` and `$(…)` count too. Reading, `git checkout -- <file>`, `git restore` and
deleting aren't blocked, and neither is running the recorded regenerate command exactly as the settings give it,
on its own.

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
unknown variable is blocked ("can't tell where this delete points; use an explicit path"). The message names the
full path, with `~` expanded and symlinks resolved, so `rm -rf ~/precious` reads (`<home>` is the real home
folder's path):

> Cartwright blocked this (destructive-outside-project): it would delete <home>/precious, which is outside this
> project, the temporary folder and Cartwright's cache. Work inside the project, or ask the person to run it
> themselves. If the team works there routinely, they can add it to locations.allowed in the settings through a
> pull request. …

### `guardrail-files`

Changing the guardrail settings needs the person's approval at that moment. That covers:
- `.cartwright/settings.json` or `profile.json`, and deleting or moving `.cartwright/`;
- the Cartwright section of `AGENTS.md` (an edit inside it, or any shell write to `AGENTS.md`, or to the file it
  links to when it's a symlink);
- the machine-mode files and the project's machine-mode folder;
- running `profile.mjs write` or `refresh`;
- `git rm`, `git mv` (from or onto these paths), `git checkout -- <path>` and `git restore <path>` on these paths (putting back an older
  settings file can loosen the rules);
- `git stash`, `git clean -f`, `git reset --hard`, `git checkout -f` and `git checkout -- .`, **only when** they would
  destroy guardrail content that isn't committed (one `git status` on those paths decides);
- `chmod`, `chown`, `chgrp`, `chflags`, `setfacl` and `xattr` on them;
- disabling, uninstalling or removing the plugin or its marketplace (`claude|codex|copilot plugin …`);
- switching its hooks off in an agent's settings file. An edit is judged by what it writes (`disableAllHooks`,
  `"cartwright@…": false`); any shell write, move or delete of `.claude/settings*.json`,
  `.github/copilot/settings.json` or `.codex/config.toml` needs the person.

Switching or checking out branches, pulling, merging, rebasing and `git reset <commit>` without `--hard` stay
allowed. The personal file is in the folder, so it's covered by deleting or moving the folder, but editing it is
the developer's own business: it can only tighten.

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

- **Command matching.** Phase 3's auditor closes the loop on what it can't see:
  - writes made inside a script or an interpreter (`node -e`, `python -c`, `npm run x` that pushes);
  - scripts assembled at run time (`sh -c "$CMD"`, `eval "$X"`, `eval "$(printf …)"`);
  - a shell reading its script from a file or from a pipe that isn't literal `echo`/`printf` text;
  - `xargs rm` and `xargs sed -i` with paths from stdin;
  - `git $SUB …`, where the subcommand is a variable;
  - a renamed copy of `profile.mjs`;
  - branch and commit operations that change the guardrail files' committed history (checkout, merge, rebase,
    reset to a commit).
- **Windows.** The hooks run through `sh`, so there are no hard blocks on Windows. The guard does nothing there
  and says so.
- **Codex** runs plugin hooks only after you approve them in `/hooks`. Until then they silently don't run.
  Approving once covers updates, because the hook entries never change.
- **Speed.** Each guarded tool call starts Node: about 0.1–0.3 s in all. The budgets for what the guard adds on
  top of starting Node are 100 ms without git and 400 ms for a push. The guard test compares 30 paired runs (with
  and without the guard) and fails when the median difference is more than twice the budget (200 ms and 800 ms),
  so a busy machine doesn't fail it.

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
- broken settings, including unreadable files and folders;
- the session start, through the real hook entry: the offer table and its replies (B12–B14), grounding in every
  storage mode, drift found in-process, guardrail health, the plugin-root cache, Copilot's JSON, `status.profile`,
  and the time the hook adds (E45).

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
time. The suite also reports p50 and p95, and judges the time on the median of 30 paired differences, failing at
twice the budget (see *Speed* above). To add a case, add an entry to the table.
