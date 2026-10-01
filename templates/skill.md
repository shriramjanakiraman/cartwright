---
name: your-skill-name
description: "What this skill does, and when an agent should use it. Mention the triggers a developer would actually say. Say when not to use it if that is easy to confuse."
owner: your-github-handle
version: 0.1.0
status: draft
scope: common
applies-to: [any]
depends-on: []
agents-tested: [claude-code]
last-reviewed: 2026-01-01
---

# your-skill-name

One or two sentences: the outcome this skill produces and who it is for.

## When to use

- The situations that should trigger this skill.
- **Skip** when: the situations that look similar but shouldn't.

## Steps

### Step 0 — Fast check

Cheap existence or version checks. If everything is already in place, say so and stop.

### Step 1 — …

Ask before assuming. Invoke other skills by name instead of copying what they do.

## How to verify

The exact commands or observations that prove the work is done.

## Constraints

- Agent-agnostic: ask which agent if it matters.
- Never invent scope, credentials or configuration; ask.
- Confirm before anything outward-facing (posting, pushing, deploying).

## References

- Official docs or skills this builds on.
