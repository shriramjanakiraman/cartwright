# Working in this repo (instructions for AI agents)

Read by Codex, Copilot and other agents directly, and by Claude Code through `CLAUDE.md`. These rules
apply to every change you make here, whoever asks for it. The full policy is in GOVERNANCE.md.

## Never change `main` or `develop` directly

Every change goes on its own branch and arrives through a pull request. Never push to `main` or
`develop`, never merge a pull request unless the owner explicitly tells you to, and never invent a branch
name outside the four types below. The pre-push hook and CI refuse anything else.

## Classify the change yourself, then branch

Before editing anything, decide the branch type from what's being asked. Don't ask the developer to
choose; tell them your choice in one line with the reason, then carry on. They can correct you.

| Type | Choose it when the change… | Examples | Base → target |
|---|---|---|---|
| `feature/<name>` | **adds or improves** something: a new skill, a new capability, an enhancement to existing behaviour, docs, a refactor, a dependency or upstream update, a new check or workflow | "add a skill for SFRA unit tests", "run the upstream check daily", "make find-skill rank better" | `develop` → `develop` |
| `bugfix/<name>` | **corrects** something that is wrong: behaviour that doesn't match what the docs or the skill say it does, a failing check, a crash, a broken link, a typo that changes meaning | "the scrub scan flags placeholders", "link removes skills it shouldn't", "CI fails on pull requests" | `develop` → `develop` |
| `hotfix/<name>` | corrects something **already released on `main` that can't wait** for the next release because it's actively harming users: a leaked secret, a skill giving dangerous instructions, a broken install | "the plugin won't install for anyone", "a released skill tells agents to delete data" | `main` → `main` |
| `release/<x.y.z>` | the owner asks to **release** what's on `develop` | "cut the release", "ship 0.6.0" | `develop` → `main` |

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

## Adding or changing skills

Use the `skill-intake` skill (`core/skill-intake.md`). It covers duplicate checks, core versus client
overlay, drafting, scrubbing and validation, and ends at the same pull request flow above.
