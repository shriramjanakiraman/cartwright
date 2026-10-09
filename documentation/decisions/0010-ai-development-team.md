# 10. An AI development team with team-lead gates

**Status:** Proposed · **Date:** 2026-10-10 · **Deciders:** team lead, architect

## Context
Work arrives as quick, roughly worded requests from the team lead. The team lead wants a proper development
process run by AI agents, with every approval and discrepancy brought to them, and no hallucinated
requirements or decisions.

## Decision
Four role agents (business analyst, architect, developer, tester) coordinated by the main session, with
gates for the brief and significant designs, decision records for significant choices, and a rule to ask
instead of guessing. Process: `documentation/15-how-we-work.md`.

## Alternatives considered
- **One general agent doing everything:** faster for tiny changes, but no separation between deciding,
  building and checking, and decisions go unrecorded.
- **Separate tools per role:** the roles are plain Markdown so any agent can take one on.

## Consequences
More hand-offs and questions for small changes (the architect can declare a design small and obvious).
Decisions become traceable and challengeable.

## Links
`documentation/15-how-we-work.md`.
