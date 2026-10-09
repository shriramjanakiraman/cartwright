# Client setup

A developer installs the plugin once, from their agent's command line or its plugin screen. From then on,
in any client project, they get every shared SFCC skill **and** the project skills other developers wrote
for that client. Nobody hand-edits settings or adds a second plugin. This guide explains how.

```
install the plugin ─▶ open a client project ─▶ session-start hook: "not set up yet"
                                                     │
                     agent asks once: "Is this for a client? set up / not now / no client"
                                                     │ set up
                     client-setup skill ─▶ "Which client?" ─▶ registry lookup ("AC" = "Acme Corporation")
                          │ found                                   │ not found
                          ▼                                         ▼
               access check ─▶ add the project kit        guide: start project skills for
               (after asking) ─▶ PR/MR to the client repo  this client, then register them
                          │
                          ▼
               everyone who opens the project now gets core + that client's skills
```

## 1. Install the plugin

| Agent | Command line | Or in the UI |
|---|---|---|
| Claude Code | `claude plugin marketplace add shriramjanakiraman/cartwright` then `claude plugin install cartwright@cartwright` | `/plugin` → add marketplace |
| Codex | `codex plugin marketplace add shriramjanakiraman/cartwright` then `codex plugin add cartwright@cartwright` | plugin directory |
| GitHub Copilot CLI | `copilot plugin marketplace add shriramjanakiraman/cartwright` then `copilot plugin install cartwright@cartwright` | |
| VS Code (Copilot) | | *Chat: Install Plugin From Source* → `shriramjanakiraman/cartwright` |

While the library repo is private, the developer's git account needs read access to it; agents download
plugins with the machine's own git credentials.

## 2. The session-start hook

The plugin ships one hook that runs when a session starts, in Claude Code, Codex, Copilot and VS Code. In
about a quarter of a second, with no network access, it checks the project:

| Situation | What happens |
|---|---|
| not a git repo, or the library / a project skills repo itself | nothing |
| the project already has the kit | nothing |
| the developer said "no client" for this project | nothing |
| they said "not now" | nothing for 7 days, then it asks again |
| otherwise | the agent asks once: *is this project for a client?* (set up / not now / no client) |

Choices are remembered per project in `~/.cartwright/projects.json` on the developer's machine.

- **Codex** asks you to trust a plugin's hook once (`/hooks`).
- The hook runs through `sh`, so on Windows it stays silent; ask the agent to "set up this project's skills"
  instead.
- Whatever the agent, asking for setup in plain words loads the same `client-setup` skill.

## 3. Finding the client: the registry

Developers type a client's name however they know it: "Acme Corporation", "AC", "acme-corporation". The registry
in `registry/overlays.json` maps those to the client's project skills repo **without the library containing
any client name**:

- Each name form (the full name, the name without "Inc"/"Ltd" and similar, and its initials) is stretched
  with scrypt into a lookup id and a key. An entry stores only that id and the details (project code, client
  name, project skills repo, lead) encrypted with that key.
- Typing any registered form finds and decrypts the entry. Without a name, the file is unreadable.
- A typed full name beats shared initials: "Acme Corporation" finds only Acme Corporation even if another client is
  also "AC". An unknown name that only shares initials shows the candidates for the developer to choose.
- **Limit:** a short alias like "AC" can be guessed by someone trying likely names, which would confirm the
  client exists. The key stretching makes each guess slow, but can't make short aliases secret.

Matching ignores case, spaces, punctuation and accents. Try it: `npm run registry -- lookup "<name>"`.

## 4. Access and the project kit

If the client is found, setup checks that the developer's git account can read the project skills repo
(`git ls-remote`, any host). If it can't, it says who to ask (the registered lead) and can still prepare
the project, so the skills appear the moment access is granted.

Then, **after asking**, it adds the **project kit** to the client project's repo, merging with files that
already exist, and offers to open a pull or merge request:

| File | Agent |
|---|---|
| `.claude/settings.json` | Claude Code (VS Code also reads it) |
| `.github/copilot/settings.json` | GitHub Copilot CLI and VS Code |
| `.agents/plugins/marketplace.json`, `.codex/config.toml` | Codex |
| `AGENT-SKILLS.md` | people: what these files are and who to ask for access |

The kit holds no skills, only pointers to the shared library and the client's project skills repo, on any
git host (GitHub, GitLab, Bitbucket, self-hosted). Once it's merged, everyone who opens the project gets both
plugins with no setup of their own. Setup also lists the commands to install both plugins on the
developer's own machine straight away.

GitHub Copilot CLI installs the declared plugins when an interactive session starts in the project (after
the folder is trusted); a headless `copilot -p` run doesn't. VS Code doesn't yet act on workspace plugin settings
([microsoft/vscode#327404](https://github.com/microsoft/vscode/issues/327404)); VS Code users install the two
plugins once with *Install Plugin From Source*.

## 5. A client with no project skills yet

Setup says so and offers to carry on with the shared skills only, or to start project skills for the client:

1. Create a private repo `<code>-cartwright` (a short lowercase code, never the client's name) under your
   own account or organisation, on any git host, from the library's `templates/overlay/`.
2. In its `overlay.json`, fill in `project`, `client`, `aliases` (every name people use: abbreviations,
   brand names), `repo` (owner/repo for GitHub, otherwise the git URL) and `lead` (who grants access).
3. Register it, from a clone of the library:
   ```bash
   npm run registry -- add --from-overlay ../<code>-cartwright
   npm run registry -- lookup "<an alias>"        # check it's found
   ```
   Commit `registry/overlays.json` and open a pull request into `develop`. It reaches developers with the
   next release.
4. Run setup again in the client project.

Project skills repos hosted outside GitHub work for installing and using skills, but the template's
automation (CI, duplicate check, weekly release) is GitHub Actions only for now.

## Files

| File | Role |
|---|---|
| `core/client-setup.md` | the skill the agent follows |
| `scripts/setup.mjs` | the helper: `hook`, `status`, `lookup`, `access`, `kit`, `install`, `remember` |
| `scripts/kit.mjs` | builds and merges the project kit (also used by `build-overlay`) |
| `scripts/registry-core.mjs`, `scripts/registry.mjs` | the encrypted registry and the command to add to it |
| `registry/overlays.json` | the registry |
| `plugin/tools/`, `plugin/hooks/hooks.json` | the same helper, registry and hook, shipped in the plugin by `npm run build` |
