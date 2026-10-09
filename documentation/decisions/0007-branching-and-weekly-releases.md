# 7. Branching model and weekly releases

**Status:** Accepted · **Date:** 2026-10-05 · **Deciders:** team lead, architect

## Context
`main` is what users install; changes need a place to be tried first, and releases need to be predictable and
correctly versioned.

## Decision
`main` (stable) and `develop` (test bed); every change through a pull request from `feature/`, `bugfix/`,
`hotfix/` or `release/`. Releases are cut weekly (Wednesdays 00:00 IST) when *Unreleased* has entries: patch
for fixes only, minor otherwise, majors only by the team lead.

## Alternatives considered
- **Trunk-based on `main`:** users would receive untested changes.
- **Manual releases only:** easy to forget; drift between `develop` and `main`.

## Consequences
Guards are signals on the free plan (rulesets need GitHub Pro or an organisation; issue #17 tracks the App
token the release workflows will then need).

## Links
`GOVERNANCE.md`, `documentation/04-branches-and-pull-requests.md`, `documentation/06-releases.md`.
