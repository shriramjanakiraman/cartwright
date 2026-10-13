---
name: project-profile
description: "Study a project of any stack (read-only), save its Cartwright profile and guardrail settings after the person approves, and keep them current. Use when the session-start notice offers to set the project up and the person replies \"set up\", or when someone says \"set up Cartwright here\", \"profile this project\", \"refresh the profile\", \"the profile is out of date\", \"change the guardrail settings\", \"protect this branch\", \"mark these files as generated\" or \"why was this blocked?\". Hands on to client-setup when the project is for a client."
owner: shriramjanakiraman
version: 0.1.0
status: active
applies-to: [any]
depends-on: [client-setup, tool:node, tool:git]
agents-tested: [claude-code, codex]
last-reviewed: 2026-10-10
---

# project-profile

Gives the agents working in a project its real facts (stack, commands, layout, conventions) instead of guesses, and
gives the team hard-block guardrails: protected branches, generated files, secrets, and nothing deleted outside the
project. Cartwright studies the project, the person confirms, and the person approves the files that are written.

## When to use

- The session-start notice offered to set the project up and the person said "set up".
- Someone asks to profile the project, refresh the profile, or change the guardrail settings (protected branches,
  generated files, allowed or protected locations, secret allow-list).
- The session-start notice says the profile is out of date and the person wants it refreshed.
- Someone asks why an action was blocked.
- **Skip** when the person only wants to use a skill, or in the Cartwright library or a project skills (overlay)
  repo.

## How to talk to the person

- Show what was found before asking anything. Ask one thing at a time, with the proposal as the default answer.
- Nothing is written until the person approves the exact command (below). Studying only reads.
- Never put a token or a secret value in a command, a file or a message.

## Steps

The helpers are `profile.mjs` and `setup.mjs`. The session-start notice gives their full paths; otherwise they're
`tools/profile.mjs` and `tools/setup.mjs` in the plugin's folder (two folders up from this skill's own `SKILL.md`).
Every command prints JSON. Run them from the project's folder.

### Step 0 — Fast check

```bash
node <setup.mjs> status
```

- `libraryRepo: true`: this is the Cartwright library or an overlay repo; stop.
- `isGitRepo: false`: ask the person to open the project's folder (the one with `.git`), then start again.
- `profile` is set: the project is already profiled. For a refresh go to Step 6, for a settings change Step 7, for a
  block Step 8. Otherwise say it's set up and stop.

### Step 1 — Study the project (read-only)

```bash
node <profile.mjs> study
```

Summarise `profile.facts` in plain words, each with its source: platform and flavour, languages, the Node or Python
pin, the package manager, the build, test and lint commands, layout, protected-branch candidates, and the
conventions (rules files, PR template, decision records, tracker). Say plainly which facts are **not found**: they
stay unknown, and agents won't guess them.

### Step 2 — Where to keep it

Ask: *"Where should Cartwright keep this? `.cartwright/` in the repo (the default, shared and reviewed like code),
a section in AGENTS.md (if the team doesn't want a new folder), or this machine only (nothing in the repo; only
you get it)."* → `folder`, `agents-md` or `machine`.

### Step 3 — Confirm the guardrail settings

Ask each, offering `proposedSettings` from Step 1 as the default:

1. **Protected branches** (agents can't push to them). Default: the detected candidates, for example `main` and
   `develop`. Globs such as `release/*` work.
2. **Generated files** (agents can't hand-edit them). Each needs the command that regenerates it. Offer the
   suggestions that came with a command; for suggestions without one (`profile.suggestions.generated` entries with
   no `regenerate`), ask for the command, or leave them out.
3. **Locations** for the delete rule. By default the project, the temporary folder and Cartwright's cache are
   allowed. Ask only if they routinely work elsewhere (allowed) or want a folder in the project protected.
4. **Is this project for a client?** yes or no.

### Step 4 — The person approves the exact command

Build the command from the answers: start from `writeCommand` in Step 1's output and change only what the person
changed. For example:

```bash
node <profile.mjs> write --store folder --protected main,develop --generated 'dist/**=npm run build'
```

Add any of these that apply:
- `--allow-location <path>` or `--protect-location <path>`, repeated;
- `--secrets-allow <glob>`, for the team's deliberate test fakes;
- `--client-project yes|no`;
- `none` for an empty list.

Show the command and what it will create (`.cartwright/profile.json`, `settings.json`, `.gitignore`, `README.md`; or
the AGENTS.md section; or files on this machine).

Writing the settings is a guardrail change, so Cartwright's guard asks the person, not you:
- where the agent shows its own approval prompt, the person approves it there;
- otherwise the guard blocks the command and says the person must run it themselves. Then give them the command to
  run in their own terminal, and wait. **Don't try another way** (another shell, a script, editing the files
  directly).

Afterwards, `node <profile.mjs> show` confirms the store and the settings that apply.

### Step 5 — Client skills, then one pull request

- **For a client:** follow the **client-setup** skill now (lookup, access check, kit). Its kit files join the same
  branch and pull request.
- **Not for a client:** `node <setup.mjs> remember no-client`.

Then offer one pull request (not for the machine-only choice, which changes nothing in the repo):

```bash
git switch -c chore/cartwright-setup
git add .cartwright/          # or AGENTS.md; plus the kit files when client-setup added them
git commit -m "Add the Cartwright project profile and guardrail settings"
git push -u origin chore/cartwright-setup
```

- **The request:** open it with `gh pr create` when `status.profile.remoteHost` is `github`, or `glab mr create` for
  `gitlab`; otherwise give the link git printed. Use the project's PR template (`status.profile.prTemplate`) for the
  body, and target the default branch (`status.profile.defaultBranch`).
- **Asking first:** branch, commit and push only after a yes for each.
- **The branch name:** follow the project's own branch rules if they differ; ask if unsure.

Finish with `node <setup.mjs> remember done`.

### Step 6 — Refresh an out-of-date profile

```bash
node <profile.mjs> diff
```

Show exactly which facts changed, before and after. On a yes, the person approves `node <profile.mjs> refresh` the same way as
Step 4 (it changes only those facts). Then offer a pull request as in Step 5, on `chore/cartwright-profile-refresh`.

### Step 7 — Change the guardrail settings

Ask what should change, then build a `write` command with only those options. A list option replaces that list;
lists not given keep their saved value. The person approves it as in Step 4, and the change goes through a pull
request, because the settings are the team's. A developer's own extra rules go in their personal file instead:
`.cartwright/personal.json` when the profile is in `.cartwright/`, or `<state>/projects/<key>/personal.json` when
it's in `AGENTS.md` or on this machine only. `<state>` is `$CARTWRIGHT_STATE_DIR` or `~/.cartwright`, and the
right `<key>` folder is the one whose `root` file names this project. It can only add or tighten, and it's never
committed.

### Step 8 — Why was this blocked?

```bash
node <plugin>/tools/guard.mjs explain "<the command>"
```

It shows the rule and the reason without running anything. Explain it, and what to do instead (for example the
regenerate command, or pushing a branch and opening a pull request). The person can run a blocked action
themselves if it really must happen. You don't try another way.

## How to verify

- `node <setup.mjs> status` shows `profile.store` and `profile.settings: "ok"`.
- `node <profile.mjs> check` exits 0 with `profiled: true`, `upToDate: true` and `settings: "ok"`. Exit 0 alone
  isn't enough: an unprofiled project exits 0 too, and so does a profile with no settings (`settings: "none"`, with
  a note that the protected-branch and generated-file rules are off).
- A new session starts with the `[cartwright] Project profile` summary.

## Constraints

- Studying is read-only; nothing is written without the person approving the exact command.
- Never bypass a block, and never hand-edit `.cartwright/settings.json`, `profile.json` or the AGENTS.md section.
- Facts come only from the profiler; never add one that it reported as not found.
- In Codex, the hooks run only after the person approves them in `/hooks`. If no `[cartwright]` session note appeared,
  ask them to.
- Agent-agnostic: the commands are the same in Claude Code, Codex and Copilot.

## References

- The *Project profile and guardrails* guide in the Cartwright library's `documentation/` folder: files, storage,
  settings, each block and its limits.
- The **client-setup** skill: connecting a client project to its project skills.
