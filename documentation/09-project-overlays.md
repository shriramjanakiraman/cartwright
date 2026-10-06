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

**Claude Code:** commit the generated `client-project-settings.json` into the **client project's** repo
as `.claude/settings.json` (merging with anything already there). Anyone opening that project is offered
core plus the overlay, for that project only. After a release: `claude plugin marketplace update
prja-agent-skills`.

**Other agents:** link at project scope into the client project, from a clone of the overlay kept on
`main`, and re-run after each release:

```bash
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project>
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project> --from ../prja-agent-skills
```

A clone left on `develop` links unreleased skills.

## When the engagement ends

Archive or delete the overlay as the client contract requires, and remove its entries from the client
project's `.claude/settings.json`. Anything worth keeping must already be [promoted to core](10-promoting-to-core.md).
