# 2. Client-specific skills live in private overlay repos

**Status:** Accepted · **Date:** 2026-10-05 · **Deciders:** team lead, architect

## Context
Skills that encode one client's systems, names or rules must never reach other clients' developers, and
GitHub permissions are per repository.

## Decision
Each engagement has its own private overlay repo (`<code>-cartwright`), built from `templates/overlay/` into
its own small plugin (`<code>-skills`). Core never contains client data; overlays may depend on core, never
the reverse. Promotion of a generic part to core goes through a scrub against the client's denylist.

## Alternatives considered
- **Client skills in core, hidden by convention:** anyone with core access could read them.
- **Skills only in the client's own repo:** simpler, but nothing shared across the client's repos and no
  release or quality process. Possible later as a light path for clients who prefer it.

## Consequences
Access is controlled by the overlay repo's permissions. Overlays need their own releases and checks
(the template provides them, GitHub Actions only for now).

## Links
`documentation/09-project-overlays.md`, `documentation/10-promoting-to-core.md`; pull requests #11, #12.
