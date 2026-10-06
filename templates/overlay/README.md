# <project-code> agent skills (overlay)

Private, engagement-only skills for **<project-code>**. It ships as its own small plugin, layered on top
of the shared core library. Only this engagement's team can read this repo, so only they can install it.

## Set up a new overlay

1. Create a **private** repo `<project-code>-agent-skills`; give only the engagement team access.
2. Copy this folder into it, hidden files included (`.github/`, `.githooks/`, `.scrub/`, `.gitignore`).
   Replace `<project-code>` everywhere with a short lowercase code such as `prja`, and fill in
   `overlay.json`. Leave its `version` at `0.1.0`; releases set it from then on.
3. Put the core owner and the project leads in `CODEOWNERS`.
4. Create `.scrub/denylist.txt` with this client's names and identifiers (see below).
5. Add a repo secret `CORE_REPO_TOKEN`: a read-only token for the core repo. CI and the release workflows
   use it to run the core scripts.
6. Clone the core repo next to this one (`../agent-skills`); the commands below run its scripts.

## Branches

Same model as the core library: `main` is what client projects install, `develop` is where new skills are
tried first, and every change arrives through a pull request, project leads included. Working branches are
`feature/<name>` or `bugfix/<name>` into `develop`, and `release/<x.y.z>` or `hotfix/<name>` into `main`;
no other names are accepted. After creating the repo:

```bash
git checkout -b develop && git push -u origin develop
git config core.hooksPath .githooks          # local guard against direct pushes
sh ../agent-skills/scripts/protect-branches.sh <owner>/<project-code>-agent-skills --overlay   # if the plan allows
```

## Add a skill

Agents follow `AGENTS.md` here (Claude Code reads it through `CLAUDE.md`) and the core library's
`skill-intake` skill. By hand:

1. From the core repo, `node scripts/new-skill.mjs --name <project-code>-<name> --description "Project <project-code> only: …" --overlay ../<this-repo>`,
   or copy `skill-template.md` to `skills/<project-code>-<name>.md`.
2. Keep three markers that tell agents and people it is project-specific:
   - the name starts with `<project-code>-`
   - `project: <project-code>` in the frontmatter
   - the description starts with `Project <project-code> only:`
3. Call core or official skills for anything generic (`depends-on`); write only the client-specific part.
4. Replace every line of template text, and set `status: active` when it's ready. Validation refuses an
   active skill that still has template text; drafts are reviewed but not shipped.
5. Build and check from the core repo, then open a pull request here:
   ```bash
   node ../agent-skills/scripts/validate.mjs --overlay .
   node ../agent-skills/scripts/build-overlay.mjs .
   ```
   Work on a `feature/<name>` branch from `develop`, add a line under *Unreleased* in `CHANGELOG.md`, and
   open the pull request into `develop`. A core owner or a project lead approves it. It reaches the team
   with the next release (see below).

## Change a skill

Same flow, on a `feature/<name>` branch (or `bugfix/<name>` for a fix): edit the skill, bump its own
`version` (patch for fixes, minor for new behaviour), update `last-reviewed`, rebuild with
`build-overlay.mjs`, add a CHANGELOG line and open the pull request into `develop`. To retire one, set
`status: deprecated`: the next release drops it from the plugin and `link` unlinks it.

## Releases

Nothing reaches the team until it's released into `main`. `develop` is never merged into `main` directly.

- **Weekly, on its own.** `release-schedule` starts `weekly-release` every Wednesday at 00:00 IST. If
  *Unreleased* has entries it cuts `release/<x.y.z>`, sets `overlay.json`'s version, rebuilds and checks,
  and opens the pull request into `main`: patch (0.1.0 → 0.1.1) for fixes only, minor (0.1.0 → 0.2.0) when
  anything is added or changed. If there's nothing new it does nothing. Majors are a lead's call: *Removed*
  or `- BREAKING:` entries open a "Weekly release needs you" issue instead. Delete `release-schedule.yml` to
  release only by hand.
- **By hand**, from the core repo: `node scripts/cut-release.mjs --overlay ../<this-repo> [x.y.z]`, then push
  `release/<x.y.z>` and open the pull request into `main`.
- **Merging** it (core owner or project lead) runs `release-gate` first, then tags `v<x.y.z>`, publishes the
  notes and opens a `main → develop` sync pull request. Merge that too.
- **The version matters.** It goes into the plugin's `plugin.json`, and Claude Code only picks up a plugin
  change when that version goes up. That's why changes ship through releases rather than straight merges.
- **Hotfix:** branch `hotfix/<name>` from `main`, fix it, add a *Fixed* line, run the release script with the
  hotfix branch checked out, and open the pull request into `main`.

## How the team gets these skills

**Claude Code:** commit the generated `client-project-settings.json` to the **client project's** repo as
`.claude/settings.json` (merge with anything already there). Anyone opening that project in Claude Code is
offered core plus this overlay, enabled for that project only. After a release, teammates update with
`claude plugin marketplace update <project-code>-agent-skills` (or the plugin manager's auto-update).

**Other agents:** link at project scope, into the client project:
```bash
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project>
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project> --from .
```

Keep the overlay clone on `main` (`git checkout main && git pull`) and re-run the second command after
each release; it links new skills and unlinks retired ones. A clone left on `develop` links unreleased
skills.

Project scope is deliberate: these skills only exist while someone is working in that client's project.

## The client denylist

`.scrub/denylist.txt` lists this client's names, brands, cartridge prefixes, site IDs and hostnames, one per
line. Whoever writes the first client-specific skill creates it; everyone after keeps it current. It never
leaves this repo. The core repo's scanner uses it whenever a skill from here is promoted to core.

## Promote a skill to core

1. Copy the generic part into the core repo as `core/<name>.md`, without the project prefix, `project`
   field or "Project … only" description.
2. Scrub it, scanning with this repo's denylist:
   `node scripts/scrub-scan.mjs --denylist ../<this-repo>/.scrub/denylist.txt core/<name>.md`
3. Open the core pull request. The project lead confirms the scrub; the core owner approves.
4. Change the overlay skill to depend on the new core skill instead of duplicating it.

## When the engagement ends

Archive or delete this repo as the client contract requires, and remove the overlay entries from the
client project's `.claude/settings.json`.
