# Working in this overlay repo (instructions for AI agents)

Read by Codex, Copilot and other agents directly, and by Claude Code through `CLAUDE.md`. These rules apply
to every change you make here, whoever asks for it.

This is the private skills repo for one engagement, **<project-code>**. Only that engagement's team can read
it. Client names, environments and business rules are fine here; secrets, credentials and tokens never are.
It ships as its own small plugin on top of the shared core library, `shriramjanakiraman/agent-skills`.
Everything below assumes the core repo is cloned next to this one, at `../agent-skills`; its scripts do
the validating, building and releasing.

## Never change `main` or `develop` directly

`main` is what the team installs; `develop` is where changes are tried first. Every change goes on its own
branch and arrives through a pull request. Never push to `main` or `develop`, never merge a pull request
unless a core owner or project lead explicitly tells you to, and never use a branch name outside the four
types below. The pre-push hook and CI refuse anything else.

## Check the open pull requests first

`gh pr list --state open`, in **this** repo only. If one is related (same skill or area, same kind of
change), it's yours or the developer's, and it isn't being merged, commit to its branch and update its title
and description. Otherwise start a new branch. If none are open, just branch.

## Classify the change yourself, then branch

Decide the type from what's asked, tell the developer in one line with the reason, then carry on.

| Type | Choose it when the change… | Base → target |
|---|---|---|
| `feature/<name>` | adds or improves something: a new project skill, better steps, docs | `develop` → `develop` |
| `bugfix/<name>` | corrects something wrong that can wait for the next release | `develop` → `develop` |
| `hotfix/<name>` | corrects something already on `main` that is actively harming the team; confirm with a lead first | `main` → `main` |
| `release/<x.y.z>` | only when a lead asks to release; normally `weekly-release` does it | `develop` → `main` |

```bash
git fetch origin && git checkout -b feature/<name> origin/develop     # hotfix: from origin/main
```

## Adding or changing a skill

Follow the core library's `skill-intake` skill (`../agent-skills/core/skill-intake.md`). In short:

1. New skill, from the core repo: `node scripts/new-skill.mjs --name <project-code>-<name> --description "Project <project-code> only: …" --overlay ../<this-repo>`.
   Changing one: edit `skills/<project-code>-<name>.md`, bump its own `version` (patch for fixes, minor for
   new behaviour) and update `last-reviewed`.
2. Keep the three markers: the name starts with `<project-code>-`, the frontmatter has `project: <project-code>`, and the
   description starts with `Project <project-code> only:`.
3. Call core or official skills for anything generic (`depends-on`); write only the client-specific part.
   If part of it would help every engagement, suggest promoting that part to core (see `README.md`).
4. Set `status: active` only when it's ready; drafts are reviewed but not shipped.
5. Check and build, from the core repo:
   ```bash
   node scripts/validate.mjs --overlay ../<this-repo>
   node scripts/scrub-scan.mjs --secrets-only ../<this-repo>/skills/*.md
   node scripts/build-overlay.mjs ../<this-repo>
   ```
6. Add one line under **Unreleased** in this repo's `CHANGELOG.md`. Don't change `overlay.json`'s version;
   the release sets it.
7. Commit the skill and the generated output (`plugin/`, `INDEX.md`, `.claude-plugin/`,
   `client-project-settings.json`), push and open the pull request into `develop`:
   `gh pr create --base develop`. Fill it in truthfully. Stop there and say it's ready for review.
8. If `duplicate-check` comments that the skill may repeat another (in this overlay, core or the official
   skills), don't just resolve it. Agree with the developer what to do (use or build on the other skill,
   combine them, or keep it because it's deliberately different), make the change, reply with the
   decision, resolve it, then add a short comment in that conversation so the check re-runs. The pull request can't be merged while a comment is open.

## Releasing

`weekly-release` runs every Wednesday at 00:00 IST. When *Unreleased* has entries it cuts
`release/<x.y.z>` and opens the pull request into `main`: patch (0.1.0 → 0.1.1) for fixes only, minor
(0.1.0 → 0.2.0) when anything is added or changed. Majors are always a lead's call. When it can't decide
it opens a "Weekly release needs you" issue.

To release by hand, only when a lead asks, from the core repo:

```bash
node scripts/cut-release.mjs --overlay ../<this-repo>            # picks patch or minor
node scripts/cut-release.mjs --overlay ../<this-repo> <x.y.z>    # a chosen version
```

Then, from this repo, `git push -u origin release/<x.y.z>` and `gh pr create --base main --title "Release <x.y.z>"`.
After a lead merges it, a `main → develop` sync pull request opens automatically; tell them.

**Hotfix:** confirm with a lead, branch `hotfix/<name>` from `origin/main`, fix it, add a *Fixed* line under
*Unreleased*, then run `node scripts/cut-release.mjs --overlay ../<this-repo>` from the core repo while the
hotfix branch is checked out here. It prepares the release in place; raise it into `main`.

## Never

- Put secrets, tokens or credentials in a skill, even here.
- Copy client material into the core repo. Promotion to core goes through a scrub against
  `.scrub/denylist.txt` and the core owner's review.
- Edit `plugin/`, `INDEX.md`, `.claude-plugin/` or `client-project-settings.json` by hand; they're generated.
