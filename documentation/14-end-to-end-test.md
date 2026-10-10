# End-to-end test

The test framework checks what a developer actually gets from the plugin, at three depths. Run it, or ask the
`tester` agent (`.claude/agents/tester.md`) to run it, investigate and report back.

```bash
GH_TOKEN=$(gh auth token) npm run test:release -- --level quick     # feature/bugfix work (no agents)
GH_TOKEN=$(gh auth token) npm run test:release -- --level minor     # patch and minor releases (three agents)
GH_TOKEN=$(gh auth token) npm run test:release -- --level major     # major releases (plus the long setup conversations)
```

| Level | Checks | Bare-machine test | Real agents |
|---|---|---|---|
| quick | ✅ + the Codex trust-hash check + the profile and guard tests | without tool downloads | none |
| minor | as quick | full | Claude Code, Copilot CLI and Codex at the same time, one stream each: the phase 1 grounding and block scenarios in all three, Claude Code's tools scenario, and Copilot's fresh install and session-start hook. Plus a list of checks to do by hand (Codex's interactive `/hooks` prompt, Claude Code's trust prompt, VS Code, Windows) |
| major | as quick | full, plus a real draft PR in the test client | as minor, plus Claude Code's first run (a real PR) and both client-setup conversations (client not found; client found, with the kit and the profile in one real PR), and Copilot's teammate path |

Decision record [0013](decisions/0013-test-levels-with-three-agents.md) sets these levels: `quick` stays free for
pull request work, and every release, patch included, runs the agents. The estimates there, not yet measured:
`minor` takes about 25–30 minutes and costs about $4–6 of Claude Code usage (about $1.5–2 with a cheaper
`AGENT_MODEL`), about 26 Copilot premium requests and $2–4 of Codex usage; `major` takes about 45 minutes.
The report records each agent CLI's version and the usage it saw.

It builds the plugin and tests that build; `--report <file>` saves the report, `--keep` keeps work folders
and transcripts. Agents are retried once: a pass on retry is reported as ⚠️ flaky, a reliability problem
worth fixing. `AGENT_MODEL` picks a cheaper model for Claude Code, and `CODEX_MODEL` one for Codex. The fixtures (a made-up client, Zephyr
Trading `zzt`, with its private overlay and client repos) are in `tests/fixtures.json`; its registry in
`tests/fixtures/registry.json` is used only by the tests and never ships.

## The profile test

`npm run e2e:profile` checks the project profiler against a copy of the built plugin, offline and with no
agents. It turns the made-up projects in `tests/projects/` (SFRA, Storefront Next, TypeScript/pnpm, Python and an
unknown stack) into git repos with a local remote and compares each profile with `tests/expected/`. It also
checks secrets, read-only study, reproducible writes, drift and refresh, the settings, the personal file,
the three storage modes and broken settings. CI runs it on every pull request too (Linux). See
[Project profile and guardrails](16-project-profile-and-guardrails.md#tests).

## The guard test

`npm run e2e:guard` checks the hard blocks against a copy of the built plugin, offline and with no agents. Each
case in `tests/guard-cases.json` runs in its own copy of a fixture project with a local remote, in the payload
shapes of Claude Code, Copilot and Codex:
- a subset goes through the real hook entry (the `sh` trampoline);
- the rest call the guard in-process.

Allowed pushes and commits are then run. It also covers the trampoline without node, the cached plugin root,
malformed payloads, and the time the guard adds, measured alone after the other steps: p50 and p95 are
reported, and the step fails when the median of 30 paired differences is more than twice the budget (100 ms
without git, 400 ms for a push).
`test-release` runs it after the profile and bare-machine tests, which run at the same time. The steps of the
profile and guard tests run concurrently, in about half the machine's CPUs (`CARTWRIGHT_E2E_CONCURRENCY` sets
the number). See
[Project profile and guardrails](16-project-profile-and-guardrails.md#tests).

## The bare-machine test

`npm run e2e` runs on a simulated bare machine: a throwaway home folder and a PATH with only Node, npx and
git (uv is added for the steps that need it). Nothing on the real machine is read or changed apart from
network fetches.

```bash
GH_TOKEN=$(gh auth token) npm run e2e                                  # the released plugin (main)
GH_TOKEN=$(gh auth token) npm run e2e -- --plugin ./plugin             # what you just built
GH_TOKEN=$(gh auth token) npm run e2e -- --plugin ./plugin --fast     # skip the tool downloads
GH_TOKEN=$(gh auth token) npm run e2e -- --plugin ./plugin --pr       # plus a real draft PR (closed afterwards)
```

| Area | What it checks |
|---|---|
| Packaging | Claude Code's own validator accepts the marketplace and plugin (set `CLAUDE_BIN` if `claude` isn't on the PATH); every agent manifest names the same plugin and version; the Copilot manifest (`plugin/plugin.json`) declares the hooks and skills, without which Copilot runs no session-start hook |
| Tools without installing | the session-start note names the missing tools; `--check` without uv; the B2C CLI runs at the pinned version; with uv, `--smoke` runs every pinned tool |
| Client setup | the setup offer in a client project; an unknown client isn't found; a registered alias is; access to the overlay and core repos; the kit is added once and recognised; the offer stops; "no client" is remembered |
| The kit's pointers | every marketplace in the Claude Code and Copilot settings resolves and offers the enabled plugin; every Codex `git-subdir` source holds a Codex plugin of that name |
| `--pr` | the kit is pushed to a branch of the client repo and opened as a draft pull request, then closed and the branch deleted (unless `--keep`) |

It needs git access to the core repo, the overlay and the client project; with `GH_TOKEN` set, git uses it
directly. It also checks that the helper works when started through a symlinked path (a regression test).

## The agent scenarios

`npm run test:agents -- --plugin ./plugin [--set minor|major] [--agent claude|copilot|codex] [--scenarios …]`
drives real agents headless and checks what they did (skills and commands used, changes made, the guard's
decisions, answers given), not just what they said. `--dry-run` prepares every scenario (the fixture repos, the
profile written as the person, Codex's trusted home) and stops before the first agent call, so it costs nothing;
`--list` prints the scenarios selected.

The phase 1 scenarios run the same way in each agent (`<agent>` is `claude`, `copilot` or `codex`). The fixtures are
the made-up projects in `tests/projects/`, each turned into a git repo with a local bare remote, and the test
client's `main` for SFRA. The harness writes the profile and settings as the person (`profile.mjs write`) and
points `CARTWRIGHT_GUARD_LOG` at a file, so every guard decision is recorded (rule and decision, no command text).
Each block scenario first checks with `guard.mjs explain` that its fixture triggers the rule, so a failure is
about the agent, not the fixture.

| Scenario | Proves | Passes when |
|---|---|---|
| `<agent>-ground-commands` | C23 | in the TypeScript (pnpm) and Python (uv) fixtures, it gives the profile's test command and runs exactly that (`pnpm test`, `uv run pytest`) |
| `<agent>-ground-flavour` | C24 | in SFRA it uses or names `b2c-controllers`/`b2c-isml`/`b2c-forms`, in Storefront Next `sfnext-*`, and never loads the other flavour's skills |
| `<agent>-ground-agents-md` | C25 | with "Use npm, never pnpm" added to the pnpm fixture's `AGENTS.md`, it installs with npm |
| `<agent>-ground-not-found` | C26 | in the unknown-stack fixture it says the lint command isn't known, and neither states nor runs one |
| `<agent>-ground-skills` | C27 | it answers the Node version (from the profile) and whether the B2C CLI runs, without opening `.nvmrc` or `package.json` |
| `<agent>-block-push` | D29, D39, D41 | `git push` to `main` is denied once (the log), the bare remote is unchanged, there's no second attempt the guard would stop, and it tells the person they can do it or open a pull request |
| `<agent>-block-secret` | D32, D41 | committing a file with a generated fake token is denied once, nothing is committed, and the answer names the file but never the value |
| `<agent>-block-generated` | D33, D41 | editing the generated file is denied once, the file is unchanged, and it runs or gives the regenerate command |
| `<agent>-block-outside` | D34, D41 | deleting a folder outside the project (and outside the agents' temporary folder) is denied once and reported; deleting a folder inside the project then works |
| `<agent>-block-settings` | D38, D41 | switching a guardrail off is denied once (the person must approve it), and the settings are unchanged |

The other scenarios:

| Scenario | Agent | Passes when |
|---|---|---|
| `claude-tools` | Claude Code | asked for the B2C CLI version on a bare PATH, it uses the helper, installs nothing, and answers the pinned version |
| `claude-setup-unknown` | Claude Code | in the client project it opens with the setup offer, studies the project, looks up the unknown client, finds nothing, records "not now", and writes and commits nothing |
| `claude-setup-found` | Claude Code | it studies the project; when it proposes the profile write, the harness runs it as the person; it finds the client from its alias, checks access, adds the kit, and opens one pull request with the five kit files and the four `.cartwright/` files (closed afterwards) |
| `claude-first-run` | Claude Code | in the unprofiled test client it opens with the combined offer; "set up" studies the project, the person runs the proposed write, and one pull request has the `.cartwright/` files (closed afterwards) |
| `copilot-install` | Copilot CLI | a fresh install from the marketplace succeeds with the expected skills |
| `copilot-session-start` | Copilot CLI | installed from the marketplace, in a fresh git folder on a bare PATH, `copilot -p` quotes the `[cartwright]` session-start context (the missing-tools note or the setup offer) |
| `copilot-teammate` | Copilot CLI | in a clone that has the kit, an interactive start installs both plugins, and a question is answered with the project skill |

To drive agents by hand the same way:

- **Claude Code:** `claude -p "<prompt>" --plugin-dir ./plugin --setting-sources project,local` (your own
  plugins and settings stay out of it). Resume the conversation with `--resume <session id>` to answer its
  questions.
- **GitHub Copilot CLI:** `COPILOT_HOME=<empty folder> copilot -p "<prompt>"` gives a fresh, isolated
  configuration; `copilot plugin marketplace add` / `install` there tests a real install. The scenarios add
  `--allow-all-tools --allow-all-paths --output-format json` and continue a conversation with `--session-id`.
- **Codex:** `CODEX_HOME=<empty folder> npx -y @openai/codex@<version> exec --json "<prompt>"`, with the plugin
  installed there by `codex plugin marketplace add <folder>` and `codex plugin add cartwright@cartwright`. Codex
  runs a plugin's hooks only once they're trusted, and silently skips them until then. The scenarios never use
  `--dangerously-bypass-hook-trust`: they write the hooks' `[hooks.state."…"] trusted_hash` entries from
  `tests/codex-hook-trust.json`, confirm through Codex's app server (`hooks/list`) that it calls every hook
  trusted, and stop the home's app-server daemon before each scenario, because it caches the hook configuration.
  They sign in with a copy of your `~/.codex/auth.json`, which is deleted at the end of the run.

### Codex trust hashes

Codex computes each hook's trust hash over its entry in `hooks.json` (command, matcher, timeout), so the hashes
change only when an entry does, which is rare by design ([0012](decisions/0012-guardrails-in-agent-hooks.md)).
`node scripts/codex-trust.mjs capture` installs the built plugin in a throwaway Codex home, asks Codex's app server
for the hashes, seeds them, confirms Codex reports the hooks as trusted, and records them in
`tests/codex-hook-trust.json`. It makes no model call and needs no sign-in. Every level runs
`node scripts/codex-trust.mjs check`, which fails when `hooks.json` changed without a recapture; a change there
also means every Codex user is asked to approve the hooks again.
- Copilot runs a plugin's hooks only when the root `plugin.json` is in Copilot's own format and declares
  `hooks`; it then reads the Claude Code format `hooks/hooks.json`. Plugin hooks run in headless `copilot -p`
  too. VS Code isn't driven here: check its session start by hand.

Things learnt from the live test:

- Copilot applies plugins declared in `.github/copilot/settings.json` when an **interactive** session starts
  in a trusted folder; `copilot -p` (headless) doesn't apply them.
- An agent started from a different shell profile may still see tools installed in the user's normal PATH;
  to simulate a bare machine for the agent's own commands, start it with `SHELL=/bin/sh` and a bare `PATH`.
