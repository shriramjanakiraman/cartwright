# Promoting a skill to core

When a project skill turns out to be useful beyond one engagement, its generic part moves into the shared
library. It takes **two pull requests, one per repo, in a fixed order**, with a release in between. An
agent can run the whole thing through `skill-intake` ("promote this project skill").

```
1 split ─▶ 2 denylist ready ─▶ 3 core PR ─▶ 4 core release (weekly) ─▶ 5 overlay PR
```

## 1. Split it

Decide what would help another engagement with the names removed, and what is specific to this client.
Either the whole skill is generic, or only part of it.

## 2. Make sure the client denylist is ready

The overlay's `.scrub/denylist.txt` must list this client's names before anything leaves the overlay. The
scanner refuses a missing or empty list, so fill it in first if it's still the template
([Scrubbing](03-scrubbing.md#client-denylists)).

## 3. Core pull request

In this repo, on a `feature/<name>` branch:

- Write `core/<name>.md` **fresh**; don't copy the file, so the overlay's history doesn't come with it.
- No project prefix, no `project:` field, no "Project … only" description.
- Scrub it against the client, as well as the normal scan:
  ```bash
  node scripts/scrub-scan.mjs core/<name>.md
  node scripts/scrub-scan.mjs --denylist ../<code>-agent-skills/.scrub/denylist.txt core/<name>.md
  ```
- Open the pull request into `develop` with a CHANGELOG line. The project lead confirms the scrub; the core
  owner approves. The [duplicate check](05-duplicate-check.md) compares it with core and the official skills
  as usual (core can't see the overlay it came from).

## 4. Wait for the core release

The overlay's checks validate `depends-on` against **core's `main`**, so the overlay can only point at the
new core skill once it's released. Releases are weekly ([Releases](06-releases.md)). Updating the overlay
before then fails its CI.

## 5. Overlay pull request

In the overlay, on a `feature/<name>` branch into its `develop`, with a CHANGELOG line:

- **Part of it was generic:** cut the overlay skill down to the client-specific part, add the core skill to
  `depends-on`, call it by name instead of repeating it, and bump the skill's `version`.
- **All of it was generic:** set the overlay skill to `status: deprecated` and name the replacing core skill
  in `## When to use`. The overlay's next release drops it and `link` unlinks it. Delete the file one
  release later.

The team then gets the core skill through the core plugin (already enabled by the client project's
settings) and the trimmed or retired overlay skill with the overlay's next release.
