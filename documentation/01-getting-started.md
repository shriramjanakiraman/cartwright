# Getting started

Whichever agent you use, you receive the same set: our core skills plus every bundled official Salesforce
skill. Claude Code users also get the B2C MCP server.

## Claude Code

One install, kept current by the plugin manager:

```bash
claude plugin marketplace add shriramjanakiraman/agent-skills
claude plugin install agent-skills@agent-skills
```

After a release, update with `claude plugin marketplace update agent-skills` (or let the plugin manager's
auto-update do it). Claude Code only picks up a change when the plugin's version goes up, which is why
changes reach users through [releases](06-releases.md).

If you already installed Salesforce's own plugins, disable them, or every official skill appears twice.

## Codex

The repo is also a Codex plugin marketplace, with the same skills and the B2C MCP server:

```bash
codex plugin marketplace add shriramjanakiraman/agent-skills
codex plugin add agent-skills@agent-skills
```

Or in the Codex app: open a clone of this repo as a workspace, restart Codex, then install **Agent Skills**
from the plugin directory. That route also works when the command line can't reach the private repo
with your GitHub credentials.

Like Claude Code, Codex picks up a change when a release raises the plugin's version. If you installed
Salesforce's own B2C plugins in Codex, or have their skills in `~/.codex/skills`, disable or move them, or
every official skill appears twice.

## Cursor, Copilot, Windsurf, OpenCode, Agentforce Vibes and others

Clone once, then link the skills into the agent's skill folder:

```bash
git clone https://github.com/shriramjanakiraman/agent-skills.git
cd agent-skills
npm run link -- --agent codex                                   # global: every project on this machine
npm run link -- --agent codex --scope project --project-dir ../my-repo   # one project only
npm run link -- --agent cursor --dry-run                        # show what would change
```

| `--agent` | Global folder | Project folder |
|---|---|---|
| `claude-code` | `~/.claude/skills` | `.claude/skills` |
| `cursor` | `~/.cursor/skills` | `.cursor/skills` |
| `vscode` (Copilot) | `~/.copilot/skills` | `.github/skills` |
| `codex` (if you don't use the plugin) | `~/.codex/skills` | `.codex/skills` |
| `windsurf` | `~/.codeium/windsurf/skills` | `.windsurf/skills` |
| `opencode` | `~/.config/opencode/skills` | `.opencode/skills` |
| `agentforce-vibes` | (project only) | `.a4drules/skills` |
| `manual` | `~/.agents/skills` | `.agents/skills` |

`link` creates a symbolic link per skill. It's safe to re-run: it adds new skills, refreshes moved ones and
removes links to deleted or deprecated skills. It never touches files that don't point into this repo.

**Keep the clone on `main`** (what's released) and re-run `link` after every `git pull`.

## Staying current

`scripts/check-updates.sh` does one `git fetch` and reports how far your clone is behind. Exit code 0
means current, 1 means behind (pull and re-link), 2 means it couldn't check. Skills call it in their quick
prerequisite step, so you're told to update instead of silently using old skills.

## Client projects

If you work on an engagement that has its own overlay repo, its skills are added **per project**, only
inside that client's project. See [Project overlays](09-project-overlays.md#how-the-team-gets-the-skills).

## What's included

[INDEX.md](../INDEX.md) lists every skill you receive, with its source and version. Two official sets are
deliberately not bundled: the Storefront Next template's own skills (they only work inside a template
project) and Salesforce's unpublished experimental set.
