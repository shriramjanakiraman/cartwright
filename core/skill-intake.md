---
name: skill-intake
description: "Turn an idea, a workflow you just did, notes, or an existing project skill into a properly classified, scrubbed and submitted skill for the shared agent-skills library, with the agent doing the work and the developer answering a few questions. Use when a developer says things like \"make this a skill\", \"save this as a skill\", \"I want to add a skill\", \"contribute this to the skills repo\", \"promote this project skill\", or \"improve the X skill\". Not for using an existing skill."
owner: shriramjanakiraman
version: 0.4.3
status: active
applies-to: [any]
depends-on: [tool:git, tool:gh, tool:node]
agents-tested: [claude-code]
last-reviewed: 2026-10-06
---

# skill-intake

Gets a skill from "this would be useful" to an open pull request with as little effort from the
developer as possible. **You do the work; the developer answers a few questions and reviews one draft.**
Everything follows the library's CONTRIBUTING.md; this skill is the guided path through it.

## When to use

- A developer wants to create a new skill, save a workflow they just completed, or contribute notes,
  a doc or a script as a skill.
- A developer wants to promote a skill from a client project into the shared library.
- A developer wants to improve an existing skill in the library (use the shortened path at the end).
- **Skip** when they just want to *use* a skill, or when the request is a one-off task that nobody
  will repeat.

## How to work with the developer

- Ask at most three questions before showing a draft. Never ask for something you can infer from the
  conversation, the repo or the tools.
- Explain each step in one plain sentence as you go. No jargon about "doors" or "frontmatter".
- Show the draft once, take their edits, then move on.
- Get an explicit yes before anything leaves their machine: pushing a branch or opening a pull request.

## Steps

### Step 0 — Find the library and check it's ready

1. Locate the agent-skills repo (the shared library; its README names the GitHub repo). In order:
   - if the current directory is it (`package.json` has `"name": "agent-skills"`), use it;
   - otherwise ask the developer where their clone is, and confirm with `git -C <path> remote get-url origin`;
   - if they have none, offer to clone it with `gh repo clone <owner>/agent-skills`.
2. Make sure it's current: `sh scripts/check-updates.sh`. If it's behind, `git pull` first.
3. Check `node --version` (20+) and `gh auth status` (needed only for the pull request at the end).
   If something is missing, say what and how to fix it; don't stop the rest of the flow for `gh`.

### Step 1 — Capture the idea, from context first

Work out what the skill should do, using the best source available:

1. **A workflow just done in this session.** Draft from the actual steps, commands and decisions that
   worked, including the mistakes worth warning about.
2. **Material the developer gives you:** notes, a doc, a script, a ticket, or an existing project skill.
3. **Only if neither exists**, ask:
   - What should it do, start to finish?
   - What would someone type when they need it? (two or three example requests)
   - Is any of it specific to one client?

Play it back in two lines ("A skill that … , used when …") and get a yes before going further.

### Step 2 — Make sure it doesn't already exist

Run, from the library root, with the key words of the idea:

```bash
node scripts/find-skill.mjs "<key words>"
node scripts/find-skill.mjs "<key words>" --overlay <path-to-overlay>   # if it's client work
```

Read the top two or three matches, then tell the developer which case applies:

- **An official Salesforce skill already does it.** Name it and explain how to use it. Stop here; offer
  to note the improvement they wanted so it can be raised with Salesforce.
- **One of our skills does most of it.** Propose improving that skill instead (see "Improving an
  existing skill" below).
- **Nothing covers it.** Continue.

### Step 3 — Decide where it belongs

Infer the answer from what you've captured, then confirm it with the developer in one question:

| What you see | Destination |
|---|---|
| Generic: would help on another project with names removed | **Core** (`core/`), the shared library |
| Client names, environments, business rules or integrations | **The client's overlay repo**, private to that engagement |
| A reusable pattern wrapped in client specifics | **Split**: generic part to core, client part to the overlay, the overlay skill depending on the core one |

For client work, ask which engagement and find its overlay repo (named `<project-code>-agent-skills`).
If none exists yet, explain that one is needed and point to `templates/overlay/README.md` in the library.
Don't create a GitHub repo without the developer's explicit go-ahead.

### Step 4 — Draft it

1. Pick a short kebab-case name that says what it does. Write a description that says what it does
   **and** when to use it, including the phrases from Step 1. Agents choose skills by this text alone.
2. Create the file with the correct labels and owner filled in automatically:
   ```bash
   node scripts/new-skill.mjs --name <name> --description "<description>" --applies-to <any|sfra|storefront-next|pwa-kit>
   node scripts/new-skill.mjs --name <name> --description "<description>" --overlay <path-to-overlay>   # client skill
   ```
   For a client skill this adds the project prefix, the `project` field and the "Project … only:"
   description start automatically. The owner is the developer's GitHub handle, taken from
   `git config github.user` if set, otherwise the signed-in `gh` account. If that's the wrong account,
   pass `--owner <handle>`.
3. Replace the template text with the real content:
   - **When to use**, including a **Skip** line for look-alike situations.
   - **Steps**, starting with a cheap check of what's already done. Ask instead of assuming. Where
     another skill already does a step, call it by name and add it to `depends-on`; don't copy it.
   - **How to verify**: the commands or observations that prove it worked.
   - **Constraints**, and **References**.
4. Keep it agent-agnostic (no "use the Bash tool"), machine-agnostic (no local paths), and free of
   anything that only works on one person's setup.
5. Show the developer the draft and apply their changes.

### Step 5 — Scrub it

Remove anything that could leak one client's information to everyone else.

- **Core skill:**
  ```bash
  node scripts/scrub-scan.mjs core/<name>.md
  # if any of it came from client work, also scan against that client's list:
  node scripts/scrub-scan.mjs --denylist <path-to-overlay>/.scrub/denylist.txt core/<name>.md
  ```
- **Overlay skill:** `node scripts/scrub-scan.mjs --secrets-only <path-to-overlay>/skills/<name>.md`

For each finding, replace the value with a placeholder: `<client>`, `<brand>`, `<project-code>`,
`<ticket-key>`, `<instance-host>`, `<org-id>`, `<short-code>`, `<site-id>`, `<client-id>`, `<repo-url>`,
`<user-home>`. Show the developer each replacement, then scan again until it's clean. Also read the text
yourself for client business rules the scanner can't recognise. Never add `scrub:allow` just to get past
the scanner.

### Step 6 — Validate and build

```bash
node scripts/validate.mjs                                   # core
node scripts/validate.mjs --overlay <path-to-overlay>       # client skill
```

Fix anything mechanical yourself, such as a missing field or section. Ask the developer whether it's
ready to ship: if yes, set `status: active`; if not, leave it `draft` (drafts are reviewed but not shipped).
Then rebuild and run the full check:

```bash
npm run build && npm run check                              # core
node scripts/build-overlay.mjs <path-to-overlay>            # client skill
```

### Step 7 — Try it

Give the developer three requests that should trigger the skill and two that shouldn't. Offer a quick
test in a fresh session: *"Read `<path to the skill>` and follow it for: <one of the requests>"*. Record
every agent it was actually tried on in `agents-tested`.

### Step 8 — Submit it, after a yes

1. Add one line under **Unreleased** in the repo's `CHANGELOG.md` (the core repo's, or the overlay's for a
   client skill). Don't change the version in `package.json` or `overlay.json`; the release sets it.
2. Enable the commit checks once if they aren't already: `npm run setup-hooks`.
3. Ask: *"Ready for me to push a branch and open the pull request?"* Only on a yes:
   ```bash
   npm run branch -- feature <name>     # new skill or improvement; bugfix <name> to fix one
   git add -A && git commit -m "Add <name> skill"
   git push -u origin feature/<name>
   gh pr create --base develop --fill --body-file <filled-in copy of .github/pull_request_template.md>
   ```
   For a client skill, run the git and `gh` commands inside the overlay repo instead, starting the branch
   with `git fetch origin && git checkout -b feature/<name> origin/develop`, and commit the regenerated
   plugin files with the skill. That repo's `AGENTS.md` has its rules.
   Always a `feature/` branch (or `bugfix/` when fixing an unreleased skill) into `develop`, in the core
   repo and in overlay repos alike. Never push to `main` or `develop` directly, and don't invent other
   branch names; both are refused.
   Fill the template truthfully: tick only the checks you actually ran, and paste the trigger prompts
   from Step 7. If the developer can't push to the repo, offer a fork or a patch file instead.

### Step 9 — Say what happens next

- CI runs the same checks on the pull request, plus a duplicate check. If it comments that the skill may
  repeat another one, go through it with the developer: use or build on the other skill, combine them, or
  keep it because it's deliberately different. Change the skill if needed, reply with the decision, then
  resolve the comment. The pull request can't be merged while one is open.
- The owner (or the project lead, for client skills) reviews and merges it into `develop`, where it's
  tried out.
- It reaches everyone with the next release. Releases are cut from `develop` automatically every
  Wednesday (00:00 IST) when there's something new, and merged into `main` by the owner or project lead.
  Claude Code users get it through the plugin update, other agents on their next pull and
  `npm run link -- --agent <agent>` (with `--from <path-to-overlay>` for client skills).

### Promoting a project skill to core

When the developer wants to move a skill from a client overlay into the shared library:

1. Read the overlay skill and split it: what would help another engagement with the names removed, and
   what is specific to this client. Show the developer the split and get a yes.
2. Check that `<path-to-overlay>/.scrub/denylist.txt` lists the client's names. If it's missing or still
   only the template's comments, the scan refuses it: build it with the developer first, from the names
   in the overlay skill, the client project and anything else they mention, and commit it in the overlay.
3. Run Steps 4 to 9 for the generic part as a **core** skill. Write it fresh rather than copying the file,
   and in Step 5 scan with the overlay's denylist as well. The project lead confirms the scrub in the pull
   request.
4. Tell the developer the overlay update has to wait until the core skill is **released** to `main`
   (the weekly release), because the overlay's checks validate `depends-on` against core's `main`. Offer
   to do it then.
5. After that release, in the overlay repo on a `feature/<name>` branch: if part of the skill was
   client-specific, trim the overlay skill to that part, add the core skill to `depends-on`, call it by
   name, and bump its `version`. If all of it moved, set `status: deprecated` and name the replacement in
   `## When to use`. Rebuild with `build-overlay.mjs`, add a CHANGELOG line, and open the pull request
   into the overlay's `develop`.

### Improving an existing skill

Skip Steps 2 and 3. Edit the skill in place on a `feature/<name>` branch (or `bugfix/<name>` for a fix),
bump its own `version` (patch for fixes, minor for new behaviour), update `last-reviewed`, then run
Steps 5 to 9.

## How to verify

- `node scripts/validate.mjs` (or `--overlay`) passes and `npm run check` is green.
- The scrub scan is clean without any new `scrub:allow` markers.
- The pull request exists, its checklist matches what was actually done, and CI passes on it.

## Constraints

- At most three questions before the first draft. Infer everything else.
- Never copy or edit official skills in `upstream/`; reference them by name.
- Never put client-specific content in core. When unsure, treat it as client-specific and ask.
- Scrub before the first commit; a later fix leaves the leak in git history.
- Never push, open a pull request or create a repository without an explicit yes.
- Agent-agnostic: give commands and outcomes, not instructions tied to one agent's tools.

## References

- `CONTRIBUTING.md`: the full standard this skill walks through.
- `templates/skill.md` and `templates/overlay/`: the drafts `new-skill.mjs` starts from.
- `scripts/find-skill.mjs`, `scripts/new-skill.mjs`, `scripts/scrub-scan.mjs`, `scripts/validate.mjs`.
