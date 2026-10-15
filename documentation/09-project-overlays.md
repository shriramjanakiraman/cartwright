# Project overlays

Client-specific skills never enter this repo: anyone with access to it could read them. Each engagement
gets its own **private overlay repo**, `<code>-cartwright`, readable only by that team. It builds into its
own small plugin that sits on top of the shared library, and is switched on only inside that client's
project.

```
client project repo ── .claude/settings.json enables ──▶  cartwright (core)  +  <code>-skills (overlay)
                                                           everyone                 engagement team only
```

The template is `templates/overlay/`; its README is the step-by-step reference for leads. Overlays follow
the same branches, pull requests and releases as core.

## Setting one up

1. Create a **private** repo `<code>-cartwright` (`<code>` is a short lowercase project code, such as
   `prja`) and give only the engagement team access.
2. Copy `templates/overlay/` into it, hidden files included. Replace `<project-code>` everywhere and fill
   in `overlay.json`: `client`, `aliases` (every name people use for the client), `repo` (owner/repo on
   GitHub, otherwise the git URL; any host works), and `lead` (who grants access). Leave `version` at `0.1.0`.
3. Put the core owner and the project leads in `CODEOWNERS`.
4. Fill in `.scrub/denylist.txt` with this client's names ([Scrubbing](03-scrubbing.md#client-denylists)).
5. Add a repo secret `CORE_REPO_TOKEN`: a read-only token for this core repo. The overlay's CI, duplicate
   check and releases use it to run the core scripts.
6. Create `develop` from `main`, enable the hooks (`git config core.hooksPath .githooks`), and clone the
   core repo next to it (`../cartwright`).
7. **Register it** so client setup can find it from any name of the client, without the core repo holding
   the name: from the core repo, `npm run registry -- add --from-overlay ../<code>-cartwright`, then a pull
   request with `registry/overlays.json` ([Client setup](12-client-setup.md#3-finding-the-client-the-registry)).

Overlays hosted outside GitHub work for installing and using skills; the template's automation below is
GitHub Actions only for now.

What the template gives the overlay:

| File | Purpose |
|---|---|
| `AGENTS.md` + `CLAUDE.md` | the rules for agents working in the overlay |
| `CHANGELOG.md`, `overlay.json` | release history and the version |
| `.githooks/pre-push` | refuses direct pushes and wrong branch names |
| `overlay-ci` | validates, checks the build is current, scans for secrets |
| `branch-name`, `branch-guard`, `release-gate`, `release` | the same guards and release steps as core |
| `release-schedule` + `weekly-release` | the Wednesday release (delete `release-schedule.yml` to release only by hand) |
| `duplicate-check` + `duplicate-recheck` | the [duplicate check](05-duplicate-check.md), against this overlay, core and the official skills |
| `client-project/` (generated) | the project kit, for leads who'd rather add it to the client project by hand |
| `.cartwright/settings.json` + `.gitignore` | starter guardrail settings: with the plugin installed, agents can't push to `main` or `develop`, hand-edit the build output (`plugin/`, `INDEX.md`, both marketplace files, `client-project/`; the message gives `node ../cartwright/scripts/build-overlay.mjs .`), commit secrets, or delete outside the repo. Changing them needs a person and a pull request; `.cartwright/personal.json` is ignored |

An **existing overlay** gets the same guardrails by copying `templates/overlay/.cartwright/` into its root and
committing it. Overlay repos are never offered Cartwright's project setup. See
[Project profile and guardrails](16-project-profile-and-guardrails.md).

## Writing project skills

Three markers make a skill visibly project-specific, and `validate --overlay` enforces all three:

- the name starts with the code: `prja-deploy-to-staging`
- the frontmatter has `project: prja`
- the description starts with `Project prja only:` (what agents read when choosing)

Other rules: an overlay skill may depend on core and official skills, never the other way round; it can't
reuse a core or official skill's name; client names are fine, secrets never are.

From the core repo:

```bash
node scripts/new-skill.mjs --name prja-<name> --description "Project prja only: …" --overlay ../prja-cartwright
node scripts/validate.mjs --overlay ../prja-cartwright
node scripts/scrub-scan.mjs --secrets-only ../prja-cartwright/skills/*.md
node scripts/build-overlay.mjs ../prja-cartwright
```

Then, in the overlay: a `feature/<name>` branch from `develop`, a CHANGELOG line, commit the skill with the
regenerated plugin files, and a pull request into `develop`. A core owner or project lead approves.
Changing a skill: bump its own `version` and `last-reviewed`. Retiring one: `status: deprecated`.

## Releases

Exactly as core ([Releases](06-releases.md)), with the version in `overlay.json`:

- weekly on Wednesdays at 00:00 IST when *Unreleased* has entries: patch for fixes only, minor otherwise,
  majors by a lead
- by hand, from the core repo: `node scripts/cut-release.mjs --overlay ../prja-cartwright [x.y.z]`
- merging the release pull request tags it and opens the `main → develop` sync

The version matters: it goes into the overlay plugin's `plugin.json`, and Claude Code only picks up a
change when it goes up. Merging into `develop` alone never reaches the team.

## How the team gets the skills

Through [client setup](12-client-setup.md): a developer who installed the core plugin opens the client
project, says which client it is, and setup adds the **project kit** to the client project's repo (after
asking), merging with any existing files:

| File in the client project | Agent | Effect |
|---|---|---|
| `.claude/settings.json` | Claude Code (VS Code reads it too) | offers core and the overlay plugin, enabled for this project only |
| `.github/copilot/settings.json` | GitHub Copilot CLI and VS Code | declares the same two plugins |
| `.agents/plugins/marketplace.json` | Codex | lists both plugins straight from their git repos |
| `.codex/config.toml` | Codex | enables both for this project |
| `AGENT-SKILLS.md` | people | what the files are, and who to ask for access |

Once it's merged, whoever opens the project gets the shared skills plus the project's skills with no setup
of their own. Leads who prefer to do it by hand can copy the same kit from the overlay's generated
`client-project/` folder. For setup to find the overlay, register it once (see *Setting one up*).

**Things to know:**

- **VS Code** currently ignores workspace plugin recommendations (open bug
  [microsoft/vscode#327404](https://github.com/microsoft/vscode/issues/327404)); Copilot CLI honours them.
  Until it's fixed, VS Code users install once by hand: *Chat: Install Plugin From Source* with the core
  repo, then with the overlay repo.
- **Credentials:** each agent downloads with the developer's own git access. "Repository not found" means
  the git credentials on that machine can't see the private repo.
- **GitHub Copilot CLI** applies the kit when an interactive session starts in the project (after trusting
  the folder), not in headless `copilot -p` runs.
- **GitHub Copilot** installs plugins per person, so once installed the overlay may also be active in that
  developer's other projects. Claude Code and Codex enable it only in the client project. The overlay's
  skills say "Project <code> only:", which keeps agents from using them elsewhere.

**Agents without plugins** link at project scope into the client project, from clones kept on `main`, and
re-run after each release:

```bash
node ../cartwright/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project>
node ../cartwright/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project> --from ../<code>-cartwright
```

A clone left on `develop` links unreleased skills.

## When the engagement ends

Archive or delete the overlay as the client contract requires, and remove its entries from the client
project's `.claude/settings.json`. Anything worth keeping must already be [promoted to core](10-promoting-to-core.md).
