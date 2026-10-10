# Documentation

How each part of the agent skills library works, one guide per feature. The rules themselves live in the
root files: [GOVERNANCE.md](../GOVERNANCE.md) (ownership, branches, releases, enforcement),
[CONTRIBUTING.md](../CONTRIBUTING.md) (the skill standard and scrub rules) and [AGENTS.md](../AGENTS.md)
(what AI agents must do in this repo). These guides explain the features and link back to the rules
rather than repeating them.

## What the library is

A shared, agent-agnostic set of skills for Salesforce B2C Commerce work. One install gives an agent our
own skills (`core/`), every official Salesforce B2C skill (mirrored in `upstream/`) and the B2C MCP server.
Client-specific skills live in separate private **overlay** repos, one per engagement.

```
                 ┌───────────────── cartwright (this repo) ─────────────────┐
 Salesforce  ──▶ │  upstream/  official skills, mirrored daily, read-only   │
 publishers      │  core/      our skills, added through pull requests      │ ──▶ plugin / link ──▶ every developer
                 └───────────────────────────────────────────────────────────┘
                 ┌───────── <code>-cartwright (one per engagement) ─────────┐
                 │  skills/    client-specific skills, private to the team  │ ──▶ plugin / link ──▶ that team, in
                 └───────────────────────────────────────────────────────────┘                     that client project
```

## Guides

| Guide | Read it when you… |
|---|---|
| [Getting started](01-getting-started.md) | want to use the skills in Claude Code, Codex, Cursor, Copilot or another agent |
| [Writing a skill](02-writing-a-skill.md) | want to add, improve or retire a skill |
| [Scrubbing](03-scrubbing.md) | need to know what may never appear in a skill, and how the scanner checks it |
| [Branches and pull requests](04-branches-and-pull-requests.md) | are about to change anything in this repo or an overlay |
| [Duplicate check](05-duplicate-check.md) | got a "possible repeat" comment on a pull request |
| [Releases](06-releases.md) | want to know how and when changes reach users |
| [Official skills (upstream)](07-official-skills-upstream.md) | review the daily upstream pull request |
| [Build and distribution](08-build-and-distribution.md) | change how skills are packaged, or wonder what `plugin/` is |
| [Project overlays](09-project-overlays.md) | set up or work in a client's private skills repo |
| [Promoting a skill to core](10-promoting-to-core.md) | want to move a project skill into the shared library |
| [Automation reference](11-automation-reference.md) | need every workflow, script and GitHub limit in one place |
| [Client setup](12-client-setup.md) | want a client project to get its project skills automatically, or a new client registered |
| [How we work](15-how-we-work.md) | want to know how the AI team (analyst, architect, developer, tester) and the team lead work together |
| [Decision records](decisions/README.md) | ask "why did we do it this way?" |
| [End-to-end test](14-end-to-end-test.md) | want to check what a developer gets from a build or release, on a bare machine |
| [Run tools without installing](13-tools-without-install.md) | are on a machine without the B2C CLI, spec-kit or graphify, or write a skill that uses them |
| [Project profile and guardrails](16-project-profile-and-guardrails.md) | want to know what Cartwright records about a project, where it keeps it, and how the team's settings and your personal file combine |

## By role

- **Developer using skills:** [Getting started](01-getting-started.md), then [Client setup](12-client-setup.md) in a client project.
  No tools to install first: see [Run tools without installing](13-tools-without-install.md).
- **Developer adding a skill:** [Writing a skill](02-writing-a-skill.md), [Scrubbing](03-scrubbing.md),
  [Branches and pull requests](04-branches-and-pull-requests.md), [Duplicate check](05-duplicate-check.md).
  An agent can do most of it for you through the `skill-intake` skill.
- **Reviewer or owner:** [Releases](06-releases.md), [Official skills](07-official-skills-upstream.md),
  [Duplicate check](05-duplicate-check.md), [Automation reference](11-automation-reference.md).
- **Project lead:** [Project overlays](09-project-overlays.md), [Client setup](12-client-setup.md), [Promoting a skill to core](10-promoting-to-core.md).
