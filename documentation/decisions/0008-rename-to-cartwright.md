# 8. Rename the library to Cartwright

**Status:** Accepted · **Date:** 2026-10-09 · **Deciders:** team lead, architect

## Context
Claude Code reserves the name `agent-skills`, so the plugin couldn't be installed under it.

## Decision
The library, repo, plugin and marketplaces are named `cartwright` (`cartwright@cartwright`); overlays are
`<code>-cartwright`. Released as 2.0.0 because install commands changed.

## Alternatives considered
Other names considered: `commerce-crew`, `sfcc-skills` (too narrow), `storeforge`, `skillshelf`,
`delivery-kit`. A distinctive name is less likely to collide with names vendors reserve.

## Consequences
Existing installs had to reinstall. The repo URL redirects from the old name.

## Links
Pull requests #28, #32.
