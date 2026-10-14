# End-to-end test

The test framework checks what a developer actually gets from the plugin, at three depths. Run it, or ask the
`tester` agent (`.claude/agents/tester.md`) to run it, investigate and report back.

```bash
GH_TOKEN=$(gh auth token) npm run test:release -- --level quick     # feature/bugfix work, patch releases (~20s)
GH_TOKEN=$(gh auth token) npm run test:release -- --level minor     # minor releases (~2 min, ~$0.25 of Claude Code)
GH_TOKEN=$(gh auth token) npm run test:release -- --level major     # major releases (~10–15 min, ~$5–10)
```

| Level | Checks | Bare-machine test | Real agents |
|---|---|---|---|
| quick | ✅ | without tool downloads | none |
| minor | ✅ | full | Claude Code: tools without installing; Copilot: fresh install and its session-start hook |
| major | ✅ | full, plus a real draft PR in the test client | Claude Code: tools, client not found, client found (kit and a real PR); Copilot: fresh install, its session-start hook and the teammate path. Plus a list of checks to do by hand (Codex, Claude Code's trust prompt, VS Code, Windows) |

It builds the plugin and tests that build; `--report <file>` saves the report, `--keep` keeps work folders
and transcripts. Agents are retried once: a pass on retry is reported as ⚠️ flaky, a reliability problem
worth fixing. `AGENT_MODEL` picks a cheaper model for Claude Code. The fixtures (a made-up client, Zephyr
Trading `zzt`, with its private overlay and client repos) are in `tests/fixtures.json`; its registry in
`tests/fixtures/registry.json` is used only by the tests and never ships.

## The bare-machine test

Every release-test level also runs the offline kit, link and tool fallback regressions against the built
plugin. Run them alone with `node scripts/test-kit-link.mjs --plugin ./plugin` (omit `--plugin` to test the
source helpers). They use temporary fixtures, require no credentials or downloads, and check malformed
JSON leaves the whole kit untouched, disabled Codex plugins are reported, foreign links are preserved,
and older installed-tool fallbacks explain their reason.

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

`npm run test:agents -- --plugin ./plugin [--scenarios …]` drives real agents headless and checks what they
did (skills and commands used, changes made, answers given), not just what they said:

| Scenario | Agent | Passes when |
|---|---|---|
| `claude-tools` | Claude Code | asked for the B2C CLI version on a bare PATH, it uses the helper, installs nothing, and answers the pinned version |
| `claude-setup-unknown` | Claude Code | in the client project it opens with the setup question, looks up the unknown client, finds nothing, records "not now", and leaves the repo alone |
| `claude-setup-found` | Claude Code | it finds the client from its alias, checks access, adds the kit, and opens a pull request with exactly the five kit files (closed afterwards) |
| `copilot-install` | Copilot CLI | a fresh install from the marketplace succeeds with the expected skills |
| `copilot-session-start` | Copilot CLI | installed from the marketplace, in a fresh git folder on a bare PATH, `copilot -p` quotes the `[cartwright]` session-start context (the missing-tools note or the setup offer) |
| `copilot-teammate` | Copilot CLI | in a clone that has the kit, an interactive start installs both plugins, and a question is answered with the project skill |

To drive agents by hand the same way:

- **Claude Code:** `claude -p "<prompt>" --plugin-dir ./plugin --setting-sources project,local` (your own
  plugins and settings stay out of it). Resume the conversation with `--resume <session id>` to answer its
  questions.
- **GitHub Copilot CLI:** `COPILOT_HOME=<empty folder> copilot -p "<prompt>"` gives a fresh, isolated
  configuration; `copilot plugin marketplace add` / `install` there tests a real install.
- Copilot runs a plugin's hooks only when the root `plugin.json` is in Copilot's own format and declares
  `hooks`; it then reads the Claude Code format `hooks/hooks.json`. Plugin hooks run in headless `copilot -p`
  too. VS Code isn't driven here: check its session start by hand.

Things learnt from the live test:

- Copilot applies plugins declared in `.github/copilot/settings.json` when an **interactive** session starts
  in a trusted folder; `copilot -p` (headless) doesn't apply them.
- An agent started from a different shell profile may still see tools installed in the user's normal PATH;
  to simulate a bare machine for the agent's own commands, start it with `SHELL=/bin/sh` and a bare `PATH`.
