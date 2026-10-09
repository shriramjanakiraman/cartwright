# 3. Find a client's overlay through an encrypted registry

**Status:** Accepted · **Date:** 2026-10-06 · **Deciders:** team lead, architect

## Context
Client setup has to find an existing overlay from whatever name a developer types (a full name, a brand, an
abbreviation),
including for developers who don't have access yet, so they don't create a duplicate. But everyone who
installs core can read core, and core must not contain client names.

## Decision
`registry/overlays.json` in core holds one entry per name form (full name, without company suffixes,
initials). Each form is stretched with scrypt into a lookup id and a key; the entry stores only the id and
the AES-GCM-encrypted details (code, client, overlay repo, lead). A typed full name beats shared initials.

## Alternatives considered
- **(a) Search only overlays the developer can already see:** no list anywhere, but duplicates when they
  lack access.
- **(b) A private readable registry:** easy, but exposes the client list to everyone who can read it.

## Consequences
Nothing in core is readable without already knowing a client name. Short aliases (two-letter abbreviations) can still be guessed,
which would confirm a client exists; scrypt makes each guess slow but can't make them secret (accepted by the
team lead). Changing the key settings orphans existing entries.

## Links
`documentation/12-client-setup.md`; pull request #23.
