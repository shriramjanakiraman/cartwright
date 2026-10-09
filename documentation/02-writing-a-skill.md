# Writing a skill

A skill is one Markdown file in `core/` with frontmatter (labels) and a few required sections. The full
standard is in [CONTRIBUTING.md](../CONTRIBUTING.md#2-write); this guide is the workflow.

## The easy way: ask an agent

Tell your agent "make this a skill", "save this as a skill" or "improve the X skill". The `skill-intake`
skill (`core/skill-intake.md`) takes over: it asks at most three questions, checks nothing already does
the job, decides core or client overlay, drafts, scrubs, validates and opens the pull request, asking
before anything is pushed.

## By hand

1. **Check it doesn't exist.** Search names and descriptions across core, the official skills and, for
   client work, an overlay:
   ```bash
   npm run find -- "deploy cartridges to a sandbox"
   npm run find -- "deploy cartridges" --overlay ../<code>-cartwright
   ```
   "LIKELY" matches are worth reading first. If an official skill already does it, use that instead.
2. **Decide where it belongs.** Generic (useful on another engagement with names removed) → core.
   Tied to one client → that client's overlay ([Project overlays](09-project-overlays.md)). A generic
   pattern wrapped in client detail → split it: generic part in core, client part in the overlay.
3. **Start a branch:** `npm run branch -- feature <name>` (see [Branches and pull requests](04-branches-and-pull-requests.md)).
4. **Create the draft** with every label filled in:
   ```bash
   npm run new-skill -- --name <name> --description "<what it does and when to use it>" --applies-to any
   ```
   The owner defaults to your GitHub handle (`git config github.user`, else the signed-in `gh` account).
5. **Write it.** Replace every line of template text. The description matters most: agents choose a skill
   from it alone, so say what it does *and* the phrases a developer would actually use. Required sections:
   `## When to use` (with a **Skip** line), `## Constraints`, `## References`. Call other skills by name
   (and list them in `depends-on`) instead of copying what they do.
6. **Scrub it** ([Scrubbing](03-scrubbing.md)), then **validate and build:**
   ```bash
   npm run build && npm run check
   ```
7. **Add a line under *Unreleased*** in `CHANGELOG.md`, commit, push and open the pull request into
   `develop`. Fill in the template honestly, including the agents you ran it on and three prompts that
   should trigger it and two that shouldn't.

## Status: draft, active, deprecated

| Status | Shipped to users? | Use it for |
|---|---|---|
| `draft` | No (listed in INDEX.md only) | work in progress you want reviewed |
| `active` | Yes | ready to use |
| `deprecated` | No; `link` removes it | retiring a skill |

`validate` refuses an **active** skill that still contains the template's stock text, so a half-written
skill can't ship.

## Improving a skill

Edit it on a `feature/` branch (or `bugfix/` for a fix), bump its own `version` (patch for fixes, minor for
new behaviour), update `last-reviewed`, then scrub, check and open the pull request as above.

## Retiring a skill

Set `status: deprecated` and say in `## When to use` why, and what replaces it. The next release drops it
from the plugin and `link` unlinks it. Delete the file one release later.

## What CI checks on your pull request

`validate` (labels, sections, names, dependencies), `scrub-scan`, the official mirror and build being
current, a secret scan across history, the branch name and target, and the [duplicate check](05-duplicate-check.md).
