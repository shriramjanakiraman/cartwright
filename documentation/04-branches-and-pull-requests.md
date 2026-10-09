# Branches and pull requests

`main` is what users install. `develop` is where changes are tried first. Nobody changes either directly,
owners included: every change arrives through a pull request. The policy is in
[GOVERNANCE.md](../GOVERNANCE.md#branches-and-pull-requests); AI agents follow [AGENTS.md](../AGENTS.md).
Overlay repos use exactly the same model.

## The four branch types

| Type | Use it when the change… | From | Pull request into |
|---|---|---|---|
| `feature/<name>` | adds or improves something: a skill, a capability, docs, a refactor | `develop` | `develop` |
| `bugfix/<name>` | corrects something that's wrong but can wait for the next release | `develop` | `develop` |
| `hotfix/<name>` | corrects something already released that is actively harming users; agree it with the owner first | `main` | `main` |
| `release/<x.y.z>` | releases `develop`; normally cut automatically ([Releases](06-releases.md)) | `develop` | `main` |

Names are lowercase words joined by hyphens: `feature/sfra-unit-tests`, `bugfix/scrub-false-positive`. A
version keeps its dots: `bugfix/sync-1.2.0`.
The only other pull request allowed is the automatic `main → develop` sync after a release.

## Everyday flow

```bash
gh pr list --state open                 # is there a related one you could add to instead?
npm run branch -- feature <name>        # picks the right base and lists open pull requests
# … make the change …
npm run build && npm run check          # regenerate outputs, then validate + scrub + build check
git add -A && git commit -m "<what changed and why>"
git push -u origin feature/<name>
gh pr create --base develop
```

- Add one line under **Unreleased** in `CHANGELOG.md`. It decides the next version
  ([Releases](06-releases.md)). Don't change `package.json`'s version; releases do that.
- Fill in the pull request template truthfully. Tick only what you did.
- The owner (or a project lead, in an overlay) reviews and merges. Stop at the open pull request.

## Adding to an open pull request instead

If an open pull request in the same repo covers the same topic and kind of change, belongs to you or the
owner, and isn't being merged, commit to its branch and update its title and description. Never add to
`feature/upstream-updates` (the upstream check rebuilds and force-pushes it) or to a `release/` branch
unless the change is release preparation. When unsure, start a new branch and mention the related one.

## What enforces this

| Guard | What it does |
|---|---|
| `pre-push` hook | refuses a push to `main` or `develop`, and any branch outside the four types. Enable once with `npm run setup-hooks`. It can be bypassed with `--no-verify`, so it catches mistakes, not intent. |
| `branch-name` workflow | fails a pull request from a wrongly named branch or aimed at the wrong target |
| `release-gate` workflow | pull requests into `main` must be a proper release or hotfix (see [Releases](06-releases.md)) |
| `branch-guard` workflow | after the fact: opens an issue if a commit reaches `main` or `develop` without a pull request, or a pull request was merged with a duplicate-check comment still open |
| `duplicate-check` workflow | holds a pull request whose skill may repeat an existing one ([Duplicate check](05-duplicate-check.md)) |
| `ci` workflow | validate, scrub, official mirror check, build check and a history-wide secret scan |

## GitHub plan limits

On a free private repo, GitHub doesn't allow branch rules ("rulesets"), so nothing can technically stop a
direct push or a merge with red checks. The guards above signal and alert instead. When the repo moves to
GitHub Pro or an organisation, run once:

```bash
sh scripts/protect-branches.sh shriramjanakiraman/cartwright
sh scripts/protect-branches.sh <owner>/<code>-cartwright --overlay     # each overlay
```

That blocks direct pushes, force pushes and deletion of `main` and `develop`, requires `check`,
`branch-name`, `duplicates` (and `release-gate` on core's `main`) to pass, and requires every review
conversation to be resolved. Required approvals start at 0 so a solo owner can merge.

Before switching it on, plan for one thing: pull requests opened by our own workflows (weekly release,
upstream, the post-release sync) get no checks, so once checks are required they can't merge as they are.
Giving those workflows a GitHub App token is the usual fix.
