# Working in this repo (instructions for AI agents)

Read by Codex, Copilot and other agents directly, and by Claude Code through `CLAUDE.md`. These rules
apply to every change you make here, whoever asks for it. The full policy is in GOVERNANCE.md; how each
feature works is in `documentation/`. When you change how a feature works, update its guide there too.

## Never change `main` or `develop` directly

Every change goes on its own branch and arrives through a pull request. Never push to `main` or
`develop`, never merge a pull request unless the owner explicitly tells you to, and never invent a branch
name outside the four types below. The pre-push hook and CI refuse anything else.

## Check the open pull requests first

Before creating a branch, list the pull requests that are **open in this repository**:
`gh pr list --state open`. This only ever applies to open pull requests in the same repo: merged or closed
ones never count, and neither do pull requests in another repo (a client overlay's pull requests are only
considered for changes to that overlay). **If none are open, skip this and start a new branch.**

If an open one is **related** to the change and you can **safely** add to it, commit to that branch instead
of opening another pull request.

It's safe to add to an open pull request only when all of these hold:

- **Same topic.** The change belongs with what that pull request already does: the same skill, script,
  workflow or doc area, or it fixes something that pull request introduced.
- **Same kind.** It fits the branch's type. Don't put a fix for something already released into an
  unrelated `feature/` branch.
- **A branch people own.** Not `feature/upstream-updates`: the upstream check rebuilds and force-pushes it,
  so your commits would be lost. Not a `release/` branch, unless the change is release preparation.
- **Ours to change.** Raised by the owner, or by an agent on the owner's behalf. Ask before adding to
  someone else's pull request.
- **Not mid-merge.** If it's being merged or was just approved for merge, start a new branch instead.

If it's safe: check out the branch, pull it, commit, push, and **update the pull request's title and
description** so they still describe everything in it. Tell the developer which pull request you added
to and why. If it isn't clearly safe, start a new branch, and mention the related pull request in the new
one. When you can't tell, ask the developer once.

## Classify the change yourself, then branch

Before editing anything, decide the branch type from what's being asked. Don't ask the developer to
choose; tell them your choice in one line with the reason, then carry on. They can correct you.

| Type | Choose it when the change… | Examples | Base → target |
|---|---|---|---|
| `feature/<name>` | **adds or improves** something: a new skill, a new capability, an enhancement to existing behaviour, docs, a refactor, a dependency or upstream update, a new check or workflow | "add a skill for SFRA unit tests", "run the upstream check daily", "make find-skill rank better" | `develop` → `develop` |
| `bugfix/<name>` | **corrects** something that is wrong: behaviour that doesn't match what the docs or the skill say it does, a failing check, a crash, a broken link, a typo that changes meaning | "the scrub scan flags placeholders", "link removes skills it shouldn't", "CI fails on pull requests" | `develop` → `develop` |
| `hotfix/<name>` | corrects something **already released on `main` that can't wait** for the next release because it's actively harming users: a leaked secret, a skill giving dangerous instructions, a broken install | "the plugin won't install for anyone", "a released skill tells agents to delete data" | `main` → `main` |
| `release/<x.y.z>` | the owner asks to **release** what's on `develop`; see *Releasing* below | "cut the release", "ship 0.6.0" | `develop` → `main` |

**Deciding between them:**

- Adds or improves → `feature`. Corrects → `bugfix`. The test is whether the request describes a problem
  with how something already works.
- A request that does both: split it if the parts are independent; otherwise use the type of the main
  intent and mention the other part in the pull request.
- Wrong on `main` but not urgent → `bugfix` from `develop`; it ships with the next release. Use
  `hotfix` only for urgent harm, and confirm with the developer before cutting one.
- Never choose `release` on your own initiative.
- Name it with a few lowercase words joined by hyphens that say what changes:
  `feature/sfra-unit-tests`, `bugfix/scrub-placeholder-false-positive`.

## The flow

```bash
gh pr list --state open               # related and safe to add to? use that branch instead (see above)
npm run branch -- feature <name>      # or bugfix / hotfix / release; picks the right base for you
# … make the change …
npm run build && npm run check        # regenerate outputs, then validate + scrub + build check
git add -A && git commit -m "<what changed and why>"
git push -u origin <type>/<name>
gh pr create --base develop           # --base main only for release/ and hotfix/
```

- Add a line under **Unreleased** in `CHANGELOG.md`. Don't change `package.json`'s version except on a
  `release/` branch.
- Run `npm run check` before every commit; the pre-commit hook runs it too.
- Fill in the pull request template truthfully. Tick only what you actually did.
- Stop at the open pull request and tell the developer it's ready for review. Don't merge it.
- If `duplicate-check` comments that a skill may repeat another, don't just resolve it. Tell the developer,
  agree what to do (use the other skill, build on it through `depends-on`, combine them, or keep it because
  it's deliberately different), make the change, reply to the comment with the decision, resolve it, then add a short comment in that
  conversation ("resolved: <decision>") so the check re-runs.

## Releasing

Releases normally happen on their own: `weekly-release` runs every Wednesday at 00:00 IST and, when
*Unreleased* has entries, cuts the release branch and opens the pull request into `main` (steps 1–3
below). If it can't decide, it opens a "Weekly release needs you" issue. Cut one by hand only when the
owner asks ("cut the release", "ship it", "release 0.6.0").

1. **Pick the version** if they didn't give one. `npm run release` with no version picks it from
   *Unreleased* in `CHANGELOG.md` (`scripts/next-version.mjs`), the same way the weekly run does:
   - **patch** (0.5.0 → 0.5.1) if it only fixes things: only *Fixed* or *Security* entries
   - **minor** (0.5.0 → 0.6.0) if it adds anything: any *Added*, *Changed* or *Deprecated* entry
   - **major** (0.x → 1.0.0, or 1.x → 2.0.0) if anything breaks how people already use the library, such as
     a renamed or removed skill, or a changed command. Never automatic: *Removed* or `- BREAKING:` entries
     make the script stop. The owner chooses major versions.

   Tell the owner the version and the one-line reason, then continue.
2. **Cut it:** `npm run release` (or `npm run release -- <x.y.z>`). It creates `release/<x.y.z>` from the latest `develop`, sets
   the version, turns *Unreleased* into `## [x.y.z] - <today>`, rebuilds, runs every check and commits.
   It refuses a version that isn't newer, and an empty *Unreleased*.
3. **Raise it:** `git push -u origin release/<x.y.z>` and `gh pr create --base main --title "Release <x.y.z>"`,
   with the release notes as the body. Stop there; the owner reviews and merges.
4. **After the owner merges**, a pull request syncing `main` back into `develop` opens automatically.
   Tell the owner. If it conflicts in `CHANGELOG.md`, resolve it on a `bugfix/sync-<x.y.z>` branch: keep
   every released section exactly as it is on `main`, and keep any entries added to `develop` since the
   release under *Unreleased*. Then raise that as a pull request into `develop`.

**Hotfix:** confirm with the owner that it can't wait for a normal release, then
`npm run branch -- hotfix <name>`, make the fix, add a *Fixed* entry under *Unreleased*, and run
`npm run release -- <patch version>` on the hotfix branch. It prepares the release in place. Raise it into
`main` exactly as in step 3; the sync back into `develop` follows the same way.

## Adding or changing skills

Use the `skill-intake` skill (`core/skill-intake.md`). It covers duplicate checks, core versus client
overlay, drafting, scrubbing and validation, and ends at the same pull request flow above.

Client overlay repos have their own `AGENTS.md` (from `templates/overlay/`) with the same branch, pull
request and release rules. The release script works for them with `--overlay <path>`. If you change how
releases or branches work here, update `templates/overlay/` to match.
