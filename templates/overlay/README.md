# <project-code> agent skills (overlay)

Private, engagement-only skills for **<project-code>**. It ships as its own small plugin, layered on top
of the shared core library. Only this engagement's team can read this repo, so only they can install it.

## Set up a new overlay

1. Create a **private** repo `<project-code>-agent-skills`; give only the engagement team access.
2. Copy this folder into it. Fill in `overlay.json` (`project` is a short lowercase code such as `prja`).
3. Put the core owner and the project leads in `CODEOWNERS`.
4. Create `.scrub/denylist.txt` with this client's names and identifiers (see below).
5. Add a repo secret `CORE_REPO_TOKEN`: a read-only token for the core repo, so CI can run its checks.

## Branches

Same model as the core library: `main` is what client projects install, `develop` is where new skills are
tried first, and every change arrives through a pull request, project leads included. After creating the
repo:

```bash
git checkout -b develop && git push -u origin develop
git config core.hooksPath .githooks          # local guard against direct pushes
sh ../agent-skills/scripts/protect-branches.sh <owner>/<project-code>-agent-skills --overlay   # if the plan allows
```

## Add a skill

1. Copy `skill-template.md` to `skills/<project-code>-<name>.md`.
2. Keep three markers that tell agents and people it is project-specific:
   - the name starts with `<project-code>-`
   - `project: <project-code>` in the frontmatter
   - the description starts with `Project <project-code> only:`
3. Call core or official skills for anything generic (`depends-on`); write only the client-specific part.
4. Build and check from the core repo, then open a pull request here:
   ```bash
   node ../agent-skills/scripts/validate.mjs --overlay .
   node ../agent-skills/scripts/build-overlay.mjs .
   ```
   Branch from `develop` and open the pull request into `develop`. A core owner or a project lead approves
   it, and it reaches the team when `develop` is merged into `main`.

## How the team gets these skills

**Claude Code:** commit the generated `client-project-settings.json` to the **client project's** repo as
`.claude/settings.json` (merge with anything already there). Anyone opening that project in Claude Code is
offered core plus this overlay, enabled for that project only. Updates arrive through the plugin manager.

**Other agents:** link at project scope, into the client project:
```bash
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project>
node ../agent-skills/scripts/link.mjs --agent <agent> --scope project --project-dir ../<client-project> --from .
```

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
