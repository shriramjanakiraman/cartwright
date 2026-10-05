<!-- feature/ and bugfix/ branches target `develop`. Only release/<x.y.z> and hotfix/ branches target `main`. -->

## What this changes

<!-- One or two sentences. -->

## Classification

- [ ] I checked `INDEX.md` → *Official skills*: no bundled official skill already does this.
- [ ] Nothing in `upstream/` is edited by hand.
- [ ] This is **reusable** across engagements. (Client-specific skills go in a project overlay repo.)
- [ ] If promoted from an overlay: the generic part only, overlay now depends on it.

## Standard

- [ ] Frontmatter complete; `name` equals the filename; `version` bumped.
- [ ] Sections: When to use (with Skip), Constraints, References.
- [ ] Agent-agnostic; invokes other skills instead of copying them.
- [ ] Ran it on: <!-- agents --> · should trigger on: <!-- 3 prompts --> · should not: <!-- 2 prompts -->

## Scrub

- [ ] No client, brand, people, ticket, hostname, org/site ID, client ID, path, IP, product or customer data.
- [ ] Placeholders from CONTRIBUTING.md used instead.
- [ ] If promoted: scanned with that overlay's `.scrub/denylist.txt`.
- [ ] Nothing sensitive was ever committed on this branch, even temporarily.

## Release

- [ ] `npm run build` run and output committed; `npm run check` passes.
- [ ] CHANGELOG entry under *Unreleased*.
