# Contributing a skill

**The easy way:** ask your agent "I want to add a skill". The `skill-intake` skill walks through every step
below for you and only asks what it can't work out itself.

Every skill enters through one door: a pull request that passes the checks below and gets an owner's
approval. Work through the four steps in order.

1. [Classify](#1-classify) — does it belong here at all?
2. [Write](#2-write) — meet the skill standard.
3. [Scrub](#3-scrub) — remove everything project-specific.
4. [Submit](#4-submit) — open the pull request.

---

## 1. Classify

Answer these in order. Stop at the first "yes".

| # | Question | If yes |
|---|---|---|
| 1 | Does an **official** skill already do this? Check `INDEX.md` → *Official skills*. Every one of them already ships in the plugin. | **Don't add it.** Invoke the official skill from your workflow, or contribute the improvement upstream. Never copy or edit anything in `upstream/`. |
| 2 | Is it tied to **one client**: their architecture, naming, integrations, business rules or environments? | **Project-specific.** It belongs in that engagement's private overlay repo, not here: named `<code>-…`, with `project: <code>` and a description starting `Project <code> only:`. Start an overlay from `templates/overlay/`. |
| 3 | Is it a pattern that would help on **two or more projects**, or at platform level, with the client details removed? | **Reusable.** Continue to step 2. |
| 4 | Is it a **mix**: a reusable core wrapped in client specifics? | **Split it.** Put the generic core here (scrubbed) and keep the client overlay in the project repo. The overlay skill depends on the core one. |

Every skill we write goes in `core/`, whatever its technology. Use `applies-to` to say which stacks it
serves.

## 2. Write

Check nothing already covers it, then create the draft with every label filled in:

```bash
npm run find -- "<what the skill would do>"
npm run new-skill -- --name <name> --description "<what it does and when to use it>" --applies-to <any|sfra|storefront-next|pwa-kit>
```

One flat file per skill in `core/`: no folders, no supporting scripts or assets.

### Required frontmatter

| Field | Rule |
|---|---|
| `name` | kebab-case, unique across this repo, equal to the filename, and not the name of an official skill |
| `description` | What it does **and** when to use it. Agents decide whether to load a skill from this alone. |
| `owner` | GitHub handle of the person accountable for it |
| `version` | semver. Bump minor for new behaviour, patch for fixes, major for a changed contract. |
| `status` | `draft` (not shipped) · `active` (shipped) · `deprecated` (removed from the plugin and unlinked) |
| `applies-to` | `any`, `sfra`, `storefront-next`, `pwa-kit` (list allowed) |
| `depends-on` | Optional. Other skills it invokes: core names, official names from `upstream.lock.json`, or `tool:<name>` |
| `agents-tested` | Agents you actually ran it on, e.g. `[claude-code, cursor]` |
| `last-reviewed` | `YYYY-MM-DD` |

### Required sections

`## When to use` (with what to skip), `## Constraints`, `## References`. The template also has
`## Steps` and `## How to verify`; use them unless the skill is purely reference material.

### House rules

- **Agent-agnostic.** Never assume the agent is Claude Code. If the underlying tool supports several
  agents, ask which one and use the tool's own selector (`--ide`, `--integration`).
- **Nothing machine-specific.** No local paths, no "already installed on my machine". Resolve versions and
  paths when the skill runs.
- **Invoke, don't duplicate.** If another skill (ours or official) already does a step, call it. Don't copy
  its logic.
- **Cheap checks first.** Check whether something is already done before doing it again.
- **Ask, don't invent.** Never fabricate acceptance criteria, scope, credentials or configuration.
- **Outward actions need confirmation.** Posting to Jira, pushing, deploying: always ask first.

### Evidence

In the pull request, show that you ran the skill on at least one agent and list three prompts that
should trigger it and two that shouldn't.

## 3. Scrub

The scrub is what stops one client's information reaching everyone else. It is mandatory for every skill
in this repo, including ones written from scratch.

### Must never appear

- client, brand or programme names, and client cartridge names
- people's names, emails or handles (except the `owner` field)
- ticket keys, ticket URLs, Atlassian site names
- instance hostnames, sandbox IDs, org IDs, SCAPI short codes, site IDs
- SLAS, OCAPI or Account Manager client IDs; any secret, token or password
- absolute local paths, internal repo URLs, IP addresses
- product, catalogue, price, order or customer data
- client business rules, thresholds or integration details

### Replace with these placeholders

| Placeholder | Stands for |
|---|---|
| `<client>` / `<brand>` | client or brand name |
| `<project-code>` | engagement code |
| `<ticket-key>` | a ticket such as `PROJ-1234` |
| `<instance-host>` | B2C instance or sandbox hostname |
| `<org-id>` · `<short-code>` · `<site-id>` | B2C identifiers |
| `<client-id>` | SLAS, OCAPI or Account Manager client ID |
| `<repo-url>` | a repository URL |
| `<user-home>` | a home or local path |

### How it's enforced

1. **You scrub first**, using the list above.
2. **Pre-commit hook** (`npm run setup-hooks`) runs `scrub-scan` on staged files and blocks the commit.
3. **CI** runs `scrub-scan` and a secret scan on every pull request.
4. **The owner confirms** the scrub checkbox in the pull request template.

**Promoting from a project overlay?** Scan against that project's client-name list as well:

```bash
node scripts/scrub-scan.mjs --denylist ../<overlay-repo>/.scrub/denylist.txt core/<name>.md
```

That list is created by whoever writes the project's first client-specific skill and kept up to date by
everyone after them. It never leaves the overlay repo.

**Scrub before the first commit.** Fixing a leak in a later commit leaves it in git history. If something
leaks, tell the owner immediately; history has to be rewritten and the remote cleaned.

**Provenance stays generic.** "Extracted from an SFRA engagement" is fine. A client name is not.

A deliberate example that trips the scanner can be allowed on its line with `<!-- scrub:allow -->`. Expect
the reviewer to ask why.

## 4. Submit

```bash
npm run build      # regenerates plugin/ and INDEX.md
npm run check      # validate + scrub-scan + build --check
```

Open a pull request and complete the template. Add a `CHANGELOG.md` entry under *Unreleased*. Don't change
the version in `package.json`; the owner sets it at release.

## Upstream changes (Door A)

The `upstream-watch` workflow opens a pull request when an official source changes. It has already
moved the pin, re-mirrored `upstream/` and rebuilt the plugin, so merging it ships the new official
skills to everyone. Before merging:

1. Check every one of our skills listed as referencing a changed upstream skill.
2. For each new official skill, check none of ours duplicates it. If one does, set ours to `deprecated`.
3. For version bumps, check the skills that install those tools still work.
4. Add a CHANGELOG entry and bump `package.json` so users receive a release.

Never edit `upstream.lock.json` or anything in `upstream/` by hand. CI fails if `upstream/` differs from
the pinned sources.

## Retiring a skill

Set `status: deprecated`, say why and what replaces it in `## When to use`, and release. The plugin drops
it and `link` unlinks it on the next run. Delete the file one release later.
