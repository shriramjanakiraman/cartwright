---
name: client-setup
description: "Connect a client project to the shared SFCC skills and that client's own project skills, so every developer who opens it gets both automatically. Use when the session-start notice says this project isn't set up, or when a developer says \"set up this project's skills\", \"connect this repo to the client skills\", \"which client skills do we have\", \"I can't see the project skills\" or \"onboard me to this client project\". Finds the client's existing project skills from any spelling or abbreviation of its name, checks access, adds the small project kit after asking, or guides creating project skills for a new client."
owner: shriramjanakiraman
version: 0.1.0
status: active
applies-to: [any]
depends-on: [tool:git, tool:node]
agents-tested: [claude-code]
last-reviewed: 2026-10-06
---

# client-setup

Gets a developer from "I just installed the plugin" to "I have the shared SFCC skills plus my client's
project skills, and so does everyone else on this project". Works the same in Claude Code, Codex, GitHub
Copilot (CLI and VS Code) and any agent that can run a command.

## When to use

- The session-start notice from the agent-skills plugin says this project isn't set up, and the developer
  answered "set up".
- A developer asks to set up, connect or check the project skills for the repo they're in, or says they
  can't see their client's skills.
- **Skip** when the developer is working in the agent-skills library or in a project skills repo itself,
  when they said the project has no client, or when they only want to *use* a skill.

## How to talk to the developer

- Ask one thing at a time, and never more than three questions in total.
- Show what you found before acting. Anything that changes a repo, a branch or a remote needs a yes first.
- Never print or store tokens. If a step needs credentials the machine doesn't have, say what's missing.

## Steps

The helper is `setup.mjs`. The session-start notice gives its full path; otherwise it's `tools/setup.mjs`
in the plugin's folder (two folders up from this skill's own `SKILL.md`), or `scripts/setup.mjs` in a clone
of the agent-skills library. Every command below prints JSON. Run them from the project's folder.

### Step 0 — Fast check

```bash
node <helper> status
```

- `libraryRepo: true`: this is the library or a project skills repo; stop, nothing to set up.
- `isGitRepo: false`: ask the developer to open the client project's repo folder, then start again.
- `kit` is set: the project is already connected to project `kit.code`. Go to Step 4 to check access, then
  stop.
- `remembered.choice` is `no-client`: the developer said there's no client; stop unless they now say there is.

### Step 1 — Which client?

Ask: *"Which client is this project for? Any name or abbreviation works."* Then:

```bash
node <helper> lookup "<what they typed>"
```

- **One `strong` match:** say *"Found the project skills for <client> (project <code>, lead <lead>)."* and
  ask them to confirm.
- **Several matches, or only `possible` ones:** list them (client, code, lead) and ask which one, or none.
- **No match:** ask once for another name the client goes by (brand, abbreviation, parent company), and look
  that up too. Still nothing: go to Step 6.

### Step 2 — Can this machine read their project skills?

```bash
node <helper> access <overlay>
```

- `canRead: false`: tell them the project skills exist but their git account can't read
  `<overlay>` yet, and to ask `<lead>` for access. Offer to continue with Step 3 anyway, so the project is
  ready the moment access is granted. Their agent will download the skills once it can.
- Also check the shared library: `node <helper> access shriramjanakiraman/agent-skills`. If that fails,
  they need access to it too.

### Step 3 — Add the project kit, after asking

Explain: *"I'll add five small files to this repo so everyone who opens it gets the shared skills plus
<client>'s project skills automatically, in Claude Code, Codex, Copilot and VS Code. They contain no
skills, only pointers. Existing settings files are merged, not replaced. Shall I?"* On a yes:

```bash
node <helper> kit --code <code> --overlay <overlay> --lead <lead>
```

Show the `changed` files and a short `git diff`. Then ask whether to open a pull or merge request:

```bash
git switch -c chore/agent-skills-setup
git add .claude/settings.json .github/copilot/settings.json .agents/plugins/marketplace.json .codex/config.toml AGENT-SKILLS.md
git commit -m "Connect this project to the shared agent skills and the <code> project skills"
git push -u origin chore/agent-skills-setup
```

Open the request with the host's own tool if it's installed (`gh pr create` for GitHub, `glab mr create` for
GitLab); otherwise give the developer the link git printed after the push. Use the branch naming and review
rules of the **client's** repo if they differ; ask if unsure.

### Step 4 — Make it work on this machine now

The kit takes effect for everyone once it's merged and they reopen the project. For this developer, right
now, get the per-agent commands and run the ones for the agent you are (ask before running):

```bash
node <helper> install --code <code> --overlay <overlay>
```

Then tell them to restart or reload their agent. Notes per agent:
- **Claude Code:** after the kit is in the project, it offers both plugins when the folder is opened and
  trusted.
- **Codex:** approve the agent-skills session hook once if `/hooks` asks.
- **VS Code:** it may not pick up workspace plugins yet (microsoft/vscode#327404); use the listed
  *Install Plugin From Source* steps once.

### Step 5 — Remember and confirm

```bash
node <helper> remember done
```

Ask the developer to start a new session and check: the agent should list skills starting with `<code>-`
alongside the shared `b2c-*` skills.

### Step 6 — No project skills for this client yet

Say so plainly, then offer two paths:

1. **Carry on with the shared skills only.** Run `node <helper> remember no-client` only if they confirm
   there's no client; otherwise `remember later`.
2. **Start project skills for this client.** Project skills live in their own private repo, which the
   developer or their lead creates under their own account or organisation, on any git host. Point them to
   the library's `templates/overlay/README.md` and its *Project overlays* guide, and summarise:
   - create a private repo named `<code>-agent-skills` (a short lowercase code, never the client's name)
   - copy the template in, set `project`, `client`, `aliases` and `lead` in `overlay.json`, and list the
     client's names in `.scrub/denylist.txt`
   - register it so others can find it: from a clone of the library,
     `node scripts/registry.mjs add --from-overlay <path-to-their-skills-repo>`, then a pull request
   - once it's registered, run this skill again to connect the project

Don't create repos, register anything or push on the developer's behalf without an explicit yes for each.

## How to verify

- `node <helper> status` shows `kit.code` for the project.
- `git status` in the client repo shows the kit files committed on the new branch, and the pull or merge
  request exists.
- A new session in the project lists `<code>-…` skills next to the shared ones.

## Constraints

- Agent-agnostic: never assume which agent is running; use the per-agent commands from `install`.
- Never write a client's name into the shared library; registration stores it encrypted, and only through
  `registry.mjs`.
- Never commit, push, open a request, create a repo or install anything without a yes.
- Don't loop: if a lookup or access check fails twice, say what's missing and stop.

## References

- `documentation/12-client-setup.md` in the agent-skills library: the whole flow and the registry.
- The *Project overlays* guide in the library's `documentation/` folder: project skills repos.
- The library's `templates/overlay/`: the starting point for a new client's project skills.
