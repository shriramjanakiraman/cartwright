# agent-skills

One shared library of **reusable, agent-agnostic skills** for delivery teams. It works with Claude Code,
Codex, Copilot, Cursor, Windsurf, OpenCode and any other agent that reads skill files.

Three rules shape everything here:

1. **Official skills are referenced, never copied.** Salesforce publishes 80+ B2C Commerce skills.
   `upstream.lock.json` pins them; we only build what they don't cover.
2. **Only scrubbed, reusable skills live here.** Client-specific skills live in that client's private
   overlay repo (see [Project overlays](#project-overlays)).
3. **Every change comes through a door.** Upstream changes through Door A, our changes through Door B.

## Layout

```
skills/common/*.md        general-purpose skills, one flat file per skill
skills/sfcc/*.md          Salesforce B2C Commerce skills
upstream.lock.json        pinned official sources (Door A)
INDEX.md                  generated catalogue (ours + official)
plugin/                   generated Claude Code plugin (do not edit)
templates/skill.md        required skeleton for a new skill
templates/overlay/        starter kit for a project overlay repo
scripts/                  validate · scrub-scan · build · upstream-check · link · check-updates
CONTRIBUTING.md           the standard: classify, write, scrub, submit
GOVERNANCE.md             owners, approvals, releases, retirement
```

## Using the library

**Claude Code** (updates through the plugin manager):

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

**Official Salesforce skills** are installed from Salesforce, not from here. See `INDEX.md` for the pinned
versions and `upstream.lock.json` for install commands.

## The two doors

| | Door A: upstream | Door B: intake |
|---|---|---|
| Trigger | Salesforce or another publisher ships a change | Someone adds or changes one of our skills |
| How it's caught | `upstream-watch` workflow, weekly and on demand | Pull request |
| Checks | Diff of versions and skill lists; our skills that reference changed upstream skills; new official skills that may duplicate ours | `validate`, `scrub-scan`, `build --check`, secret scan |
| Gate | Owner reviews the generated PR | Owner (or project lead) approval |
| Reaches users via | Release → plugin update, `link`, `check-updates` | Release → plugin update, `link`, `check-updates` |

## Project overlays

Client-specific skills never enter this repo. GitHub permissions are per repository, so a client's
material in a shared repo would be readable by everyone with access to it.

Each engagement gets its own **private overlay repo**, started from `templates/overlay/`:

- readable only by that engagement's team
- skills named `<project-code>-…`, never reusing a core name
- may depend on core skills; core never depends on an overlay
- holds its own client-name denylist at `.scrub/denylist.txt`
- archived or deleted when the engagement ends, as the client contract requires

Link an overlay into an agent alongside core with `npm run link -- --agent <agent> --from ../<overlay-repo>`.
Each source only ever removes its own stale links, so core and overlay never disturb each other.

A project skill reaches core only by **promotion**: a new pull request here, scrubbed against that
overlay's denylist. See CONTRIBUTING.md.

## Local checks

```bash
npm run setup-hooks     # once: enables the pre-commit scrub and validation
npm run check           # validate + scrub-scan + build --check
npm run build           # regenerate plugin/ and INDEX.md after editing skills
npm run upstream        # Door A report (set GH_TOKEN to avoid rate limits)
```
