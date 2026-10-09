# Automation reference

Every workflow and script in one place, and the GitHub behaviours they're built around.

## Workflows (core)

| Workflow | Runs on | Runs from | What it does |
|---|---|---|---|
| `ci` | pull requests; pushes to `main`, `develop` | the pull request / branch | validate, scrub, official mirror check, build check, gitleaks secret scan (job `check`) |
| `branch-name` | pull requests into `main`, `develop` | the pull request | allowed branch types and targets |
| `duplicate-check` | pull requests opened or updated | the pull request | possible repeats: comment, request changes, pass when resolved (job `duplicates`) |
| `duplicate-recheck` | replies to review comments; comments on a pull request | the pull request; **`main`** for pull request comments | re-runs `duplicate-check` |
| `branch-guard` | pushes to `main`, `develop` | the branch | issue on a direct push, or on a merge with an unresolved duplicate comment |
| `release-gate` | pull requests into `main` | the pull request | release or hotfix source, new version, CHANGELOG section |
| `release` | pushes to `main` | `main` | tag, release notes, `main → develop` sync pull request |
| `release-schedule` | Tuesdays 18:30 UTC (Wed 00:00 IST); by hand | **`main`** | starts `weekly-release` on `develop` |
| `weekly-release` | started by `release-schedule`; by hand | `develop` | picks the version, cuts the release, opens the pull request, or opens an issue |
| `upstream-schedule` | daily 06:00 UTC; by hand | **`main`** | starts `upstream-watch` on `develop` |
| `upstream-watch` | started by `upstream-schedule`; by hand | `develop` | compares, mirrors, checks, writes the CHANGELOG entries, keeps one upstream pull request |

Overlays get `overlay-ci` (job `check`), `branch-name`, `branch-guard`, `release-gate`, `release`,
`release-schedule`, `weekly-release`, `duplicate-check` and `duplicate-recheck` from `templates/overlay/`.

Run one by hand: `gh workflow run <file> --ref develop` (or `--ref main` for the schedules).

## Scripts

| Command | What it does |
|---|---|
| `npm run branch -- <type> <name>` | start a correctly named branch from the right base |
| `npm run new-skill -- …` | create a labelled draft skill (core or `--overlay`) |
| `npm run find -- "<words>"` | search existing skills before writing one |
| `npm run validate` | the skill standard (`--overlay <repo>` for overlays) |
| `npm run scrub` | data-leakage and secret scan (`--denylist`, `--secrets-only`) |
| `npm run build` / `build:check` | package the plugin and INDEX, or check they're current |
| `npm run check` | validate + scrub + build check |
| `npm run release [-- x.y.z]` | cut a release branch (`--overlay <repo>` for overlays) |
| `node scripts/next-version.mjs` | print the version the next release would get |
| `node scripts/similar-skills.mjs <files>` | the duplicate check, locally |
| `npm run setup -- <command>` | the client setup helper (`status`, `lookup`, `access`, `kit`, `install`, `remember`, `hook`) |
| `npm run registry -- add --from-overlay <repo>` / `lookup "<name>"` | register a client's overlay; check what setup would find |
| `npm run upstream` | compare the lock with the official sources |
| `npm run sync-upstream` / `sync-upstream:check` | re-mirror official skills, or check the mirror |
| `npm run link -- --agent <agent>` | link skills into another agent |
| `scripts/check-updates.sh` | how far a clone is behind |
| `npm run build-overlay` / `node scripts/build-overlay.mjs <repo>` | build an overlay's plugin |
| `npm run setup-hooks` | enable the pre-commit and pre-push hooks |
| `sh scripts/protect-branches.sh <owner/repo> [--overlay]` | apply GitHub rulesets (needs a plan that allows them) |

## GitHub behaviours the design works around

| Behaviour | Consequence here |
|---|---|
| Scheduled workflows only run from the default branch (`main`) | small triggers on `main` start the real work on `develop`; changing a trigger needs a release |
| `main` must stay the default branch | the Claude Code plugin installs from the default branch |
| Pull requests opened by a workflow get no checks | `upstream-watch` and `weekly-release` run every check themselves before opening; the sync pull request shows red or missing checks, which is expected |
| Comments on a pull request (`issue_comment`) run the workflow from `main` | "comment anywhere to re-run the duplicate check" works once `duplicate-recheck` is released; replies inside the conversation work straight away |
| Resolving a conversation starts no workflow | after resolving a duplicate comment, add a comment or press *Re-run* |
| Free private repos can't use rulesets | guards signal and alert instead of blocking; `protect-branches.sh` is ready for the upgrade |
