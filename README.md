# agent-skills

One shared library of **reusable, agent-agnostic skills** for delivery teams. It works with Claude Code,
Codex, Copilot, Cursor, Windsurf, OpenCode and any other agent that reads skill files.

Three rules shape everything here:

1. **One install delivers everything.** The plugin ships our own skills, every official Salesforce
   B2C Commerce skill (bundled read-only from `upstream/`) and the B2C MCP server. Official skills are
   never hand-edited; they move only when `upstream.lock.json` does. We only write what they don't cover.
2. **Only scrubbed, reusable skills live here.** Client-specific skills live in that client's private
   overlay repo (see [Project overlays](#project-overlays)).
3. **Every change comes through a door.** Upstream changes through Door A, our changes through Door B.

## Adding a skill: just ask your agent

Tell your agent **"I want to add a skill"** (or "make this a skill", or "promote this project skill"). The
`skill-intake` skill takes it from there: it checks nothing already does the job, works out whether it
belongs here or in a client overlay, drafts it, scrubs it, validates it, and opens the pull request once
you say yes. You answer a few questions and review one draft.

Prefer doing it by hand? `npm run find -- "<idea>"`, then `npm run new-skill -- --name <name> --description "..."`,
then follow CONTRIBUTING.md.

## Layout

```
core/*.md                 every skill we write, any technology, one flat file per skill
upstream/                 official skills mirrored at the pinned versions (generated, read-only)
upstream.lock.json        pinned official sources (Door A)
INDEX.md                  generated catalogue (ours + official)
plugin/                   generated plugin: core + upstream skills, MCP server, licences (do not edit)
templates/skill.md        required skeleton for a new skill
templates/overlay/        starter kit for a project overlay repo
scripts/                  validate · scrub-scan · build · upstream-check · link · check-updates
CONTRIBUTING.md           the standard: classify, write, scrub, submit
GOVERNANCE.md             owners, approvals, releases, retirement
```

## Using the library

Whichever route you use, you receive the same set: our core skills plus every bundled official skill.

**Claude Code** (one install; also registers the B2C MCP server; updates through the plugin manager):

```bash
claude plugin marketplace add shriramjanakiraman/agent-skills
claude plugin install agent-skills@agent-skills
claude plugin marketplace update agent-skills     # pick up a new release
```

**Any other agent** (clone once, then link; re-run after every pull):

```bash
git clone https://github.com/shriramjanakiraman/agent-skills.git
cd agent-skills
npm run link -- --agent cursor          # or codex, vscode, windsurf, opencode, agentforce-vibes, manual
npm run link -- --agent codex --scope project --project-dir ../my-repo
```

`link` is idempotent: it adds new skills, refreshes moved ones and removes links to deleted or
deprecated skills. It never touches files that don't point into this repo.

**Staying current.** `scripts/check-updates.sh` is a cheap check (one `git fetch`) that prints how far a
checkout is behind. Skills call it from their fast prerequisite step, so developers are told to update
instead of silently running stale skills.

**Already installed Salesforce's own plugins?** Disable them once you install this one, or every official
skill appears twice. `INDEX.md` lists exactly what is bundled and at which version. Two things are not
bundled: the Storefront Next template's skills (they only work inside a template project) and Salesforce's
unpublished experimental set.

## The two doors

| | Door A: upstream | Door B: intake |
|---|---|---|
| Trigger | Salesforce or another publisher ships a change | Someone adds or changes one of our skills |
| How it's caught | `upstream-watch` workflow, run from `develop` daily and on demand; one standing pull request into `develop` | Pull request |
| Checks | Diff of versions and skill lists; re-mirror into `upstream/`; our skills that reference changed upstream skills; new official skills that may duplicate ours | `validate`, `scrub-scan`, `sync-upstream --check`, `build --check`, secret scan |
| Gate | Owner reviews the generated PR | Owner (or project lead) approval |
| Reaches users via | Release → plugin update, `link`, `check-updates` | Release → plugin update, `link`, `check-updates` |

## Project overlays

Client-specific skills never enter this repo. GitHub permissions are per repository, so a client's material
in a shared repo would be readable by everyone with access to it. Each engagement gets its own **private
overlay repo**, started from `templates/overlay/`, which builds into its own small plugin.

```
client project repo  ── .claude/settings.json enables ──▶  agent-skills (core)  +  <code>-skills (overlay)
                                                            everyone                 engagement team only
```

**How a skill is marked as project-specific** (the overlay validator enforces all three):
- its name starts with the project code: `prja-deploy-to-staging`
- its frontmatter has `project: prja`
- its description starts with `Project prja only:`, which is what agents read when choosing a skill

**How it reaches only the right people and the right project:**
- Only the engagement team can read the overlay repo, so only they can install it.
- It is enabled at **project scope**: the client project's `.claude/settings.json` turns it on (generated
  for you as `client-project-settings.json`), and other agents link it into that project's folder. Its
  skills exist only while someone is working in that client's project.

**Rules:**
- Overlay skills may depend on core and official skills; core never depends on an overlay.
- Overlay skills can't reuse a core or official skill's name.
- Client names are allowed in an overlay; secrets never are (its CI runs a secrets-only scan).
- Each overlay keeps the client's names in `.scrub/denylist.txt`, used whenever a skill is promoted to core.
- When the engagement ends, the overlay is archived or deleted as the client contract requires.

Run the core checks against an overlay from this repo:

```bash
node scripts/validate.mjs --overlay ../<code>-agent-skills
node scripts/build-overlay.mjs ../<code>-agent-skills
```

## Branches

`main` is stable and is what everyone installs. `develop` is where new skills and features are tested first.
Every change, owners included, goes through a pull request. Work happens on `feature/` or `bugfix/` branches
into `develop`; releases go from `release/<x.y.z>` into `main`, and urgent fixes from `hotfix/`. No other
branch names are accepted. Details in GOVERNANCE.md.

## Local checks

```bash
npm run setup-hooks     # once: enables the pre-commit scrub and the pre-push branch guard
npm run branch -- feature <name>   # start work on a correctly named branch from develop
npm run release                    # cut a release branch by hand (weekly-release does it every Wednesday)
npm run check           # validate + scrub-scan + build --check
npm run build           # regenerate plugin/ and INDEX.md after editing skills
npm run upstream        # Door A report (set GH_TOKEN to avoid rate limits)
```
