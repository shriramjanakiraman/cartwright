# Project overlays

Client-specific skills never enter this repo: anyone with access to it could read them. Each engagement
gets its own **private overlay repo**, `<code>-agent-skills`, readable only by that team. It builds into its
own small plugin that sits on top of the shared library, and is switched on only inside that client's
project.

```
client project repo ── .claude/settings.json enables ──▶  agent-skills (core)  +  <code>-skills (overlay)
                                                           everyone                 engagement team only
```

The template is `templates/overlay/`; its README is the step-by-step reference for leads. Overlays follow
the same branches, pull requests and releases as core.

## Setting one up

1. Create a **private** repo `<code>-agent-skills` (`<code>` is a short lowercase project code, such as
   `prja`) and give only the engagement team access.
2. Copy `templates/overlay/` into it, hidden files included. Replace `<project-code>` everywhere and fill
   in `overlay.json`. Leave its `version` at `0.1.0`.
3. Put the core owner and the project leads in `CODEOWNERS`.
4. Fill in `.scrub/denylist.txt` with this client's names ([Scrubbing](03-scrubbing.md#client-denylists)).
5. Add a repo secret `CORE_REPO_TOKEN`: a read-only token for this core repo. The overlay's CI, duplicate
   check and releases use it to run the core scripts.
6. Create `develop` from `main`, enable the hooks (`git config core.hooksPath .githooks`), and clone the
   core repo next to it (`../agent-skills`).

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
| `client-project/` (generated) | the kit a lead commits into the client project so the team gets the skills automatically |

## Writing project skills

Three markers make a skill visibly project-specific, and `validate --overlay` enforces all three:

- the name starts with the code: `prja-deploy-to-staging`
- the frontmatter has `project: prja`
- the description starts with `Project prja only:` (what agents read when choosing)

Other rules: an overlay skill may depend on core and official skills, never the other way round; it can't
reuse a core or official skill's name; client names are fine, secrets never are.

From the core repo:

```bash
node scripts/new-skill.mjs --name prja-<name> --description "Project prja only: …" --overlay ../prja-agent-skills
node scripts/validate.mjs --overlay ../prja-agent-skills
node scripts/scrub-scan.mjs --secrets-only ../prja-agent-skills/skills/*.md
node scripts/build-overlay.mjs ../prja-agent-skills
```

Then, in the overlay: a `feature/<name>` branch from `develop`, a CHANGELOG line, commit the skill with the
regenerated plugin files, and a pull request into `develop`. A core owner or project lead approves.
Changing a skill: bump its own `version` and `last-reviewed`. Retiring one: `status: deprecated`.

## Releases

Exactly as core ([Releases](06-releases.md)), with the version in `overlay.json`:

- weekly on Wednesdays at 00:00 IST when *Unreleased* has entries: patch for fixes only, minor otherwise,
  majors by a lead
- by hand, from the core repo: `node scripts/cut-release.mjs --overlay ../prja-agent-skills [x.y.z]`
- merging the release pull request tags it and opens the `main → develop` sync

The version matters: it goes into the overlay plugin's `plugin.json`, and Claude Code only picks up a
change when it goes up. Merging into `develop` alone never reaches the team.

## How the team gets the skills

**Once per client project, a lead commits the kit.** `build-overlay` generates `client-project/` in the
overlay repo. Copy its contents (hidden folders included) into the root of the **client project's** repo
and commit them, merging with any of these files that already exist there:

| File in the client project | Agent | Effect |
|---|---|---|
| `.claude/settings.json` | Claude Code (VS Code reads it too) | offers core and the overlay plugin, enabled for this project only |
| `.github/copilot/settings.json` | GitHub Copilot CLI and VS Code | declares the same two plugins |
| `.agents/plugins/marketplace.json` | Codex | lists both plugins straight from their GitHub repos |
| `.codex/config.toml` | Codex | enables both for this project |

The kit holds no client skills, only pointers to the core and overlay repos. **After that, nobody adds
anything:** whoever opens the client project gets the shared skills plus the project's skills. Only people
whose GitHub account can read the overlay repo can download its skills; for anyone else that download
fails and they keep just the core skills.

**Updates** arrive with releases: the plugins follow each repo's `main`, and the version a release sets is
what tells each agent to refresh.

**Things to know:**

- **VS Code** currently ignores workspace plugin recommendations (open bug
  [microsoft/vscode#327404](https://github.com/microsoft/vscode/issues/327404)); Copilot CLI honours them.
  Until it's fixed, VS Code users install once by hand: *Chat: Install Plugin From Source* with the core
  repo, then with the overlay repo.
- **Credentials:** each agent downloads with the developer's own git access to GitHub. If a download fails
  with "repository not found", the git credentials on that machine can't see the private repo.
- **GitHub Copilot** installs plugins per person, so once installed the overlay may also be active in that
  developer's other projects. Claude Code and Codex enable it only in the client project. The overlay's
  skills say "Project <code> only:", which keeps agents from using them elsewhere.

**Agents without plugins** link at project scope into the client project, from clones kept on `main`, and
re-run after each release:

```bash
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project>
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project> --from ../<code>-agent-skills
```

A clone left on `develop` links unreleased skills.

## When the engagement ends

Archive or delete the overlay as the client contract requires, and remove its entries from the client
project's `.claude/settings.json`. Anything worth keeping must already be [promoted to core](10-promoting-to-core.md).
