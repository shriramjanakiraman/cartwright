# End-to-end test

`npm run e2e` checks what a developer actually gets from the plugin, on a simulated bare machine: a
throwaway home folder and a PATH with only Node, npx and git (uv is added for the steps that need it).
Nothing on the real machine is read or changed apart from network fetches.

```bash
GH_TOKEN=$(gh auth token) npm run e2e                                  # the released plugin (main)
GH_TOKEN=$(gh auth token) npm run e2e -- --plugin ./plugin             # what you just built
GH_TOKEN=$(gh auth token) npm run e2e -- --registry <file> --pr        # with a test client, plus a real PR
```

| Area | What it checks |
|---|---|
| Packaging | Claude Code's own validator accepts the marketplace and plugin (set `CLAUDE_BIN` if `claude` isn't on the PATH); every agent manifest names the same plugin and version |
| Tools without installing | the session-start note names the missing tools; `--check` without uv; the B2C CLI runs at the pinned version; with uv, `--smoke` runs every pinned tool |
| Client setup | the setup offer in a client project; an unknown client isn't found; a registered alias is; access to the overlay and core repos; the kit is added once and recognised; the offer stops; "no client" is remembered |
| The kit's pointers | every marketplace in the Claude Code and Copilot settings resolves and offers the enabled plugin; every Codex `git-subdir` source holds a Codex plugin of that name |
| `--pr` | the kit is pushed to a branch of the client repo and opened as a draft pull request, then closed and the branch deleted (unless `--keep`) |

It needs git access to the core repo, the overlay and the client project; with `GH_TOKEN` set, git uses it
directly. The defaults use the made-up test client (`zzt`, Zephyr Trading): `--client`, `--alias` and
`--unknown` point it elsewhere.

## Testing in the agents themselves

The script covers everything up to what the agent does. To see real agents use the plugin, drive them
headless with the plugin loaded for the session only, so nothing is installed:

- **Claude Code:** `claude -p "<prompt>" --plugin-dir ./plugin --setting-sources project,local` (your own
  plugins and settings stay out of it). Resume the conversation with `--resume <session id>` to answer its
  questions.
- **GitHub Copilot CLI:** `COPILOT_HOME=<empty folder> copilot -p "<prompt>"` gives a fresh, isolated
  configuration; `copilot plugin marketplace add` / `install` there tests a real install.

Things learnt from the live test:

- Copilot applies plugins declared in `.github/copilot/settings.json` when an **interactive** session starts
  in a trusted folder; `copilot -p` (headless) doesn't apply them.
- An agent started from a different shell profile may still see tools installed in the user's normal PATH;
  to simulate a bare machine for the agent's own commands, start it with `SHELL=/bin/sh` and a bare `PATH`.
