# .cartwright

This folder is Cartwright's record of this project, shared by the team and reviewed like code.

| File | What it is |
|---|---|
| `profile.json` | What Cartwright detected about the project (stack, commands, layout, conventions), each fact with the file it came from. Agents use it instead of guessing. |
| `settings.json` | The team's guardrail settings: protected branches, generated files and how to regenerate them, allowed and protected locations, extra rules. Change it in a pull request. |
| `personal.json` | Each developer's own additions. Git-ignored (see `.gitignore`); it can only add or tighten rules. |

If the project's rules files (`AGENTS.md`, `CLAUDE.md` and similar) disagree with the profile, they win.
