# 6. An offline duplicate check holds pull requests

**Status:** Accepted · **Date:** 2026-10-06 · **Deciders:** team lead, architect

## Context
The library shouldn't fill up with skills that repeat each other or Salesforce's, but some overlap is
deliberate. The team lead wanted a comment, "Request changes", and no merge until it's resolved.

## Decision
`duplicate-check` compares each added or changed skill's name and description (TF-IDF, threshold 0.35) with
the skills it can see (core: core + official; overlay: itself + core + official; never other overlays),
comments with a suggestion, requests changes, and fails until every comment is resolved. `depends-on` pairs
are never flagged. `branch-guard` opens an issue if one merges unresolved.

## Alternatives considered
- **AI review:** better judgement, but cost, and client text sent to a service. Deferred until an enterprise
  setup with Copilot.
- **Block outright on a score:** too many false positives.

## Consequences
Free and deterministic; misses rewordings with different vocabulary. On the free plan it signals rather
than blocks; resolving needs a follow-up comment to re-run the check.

## Links
`documentation/05-duplicate-check.md`; pull request #14.
