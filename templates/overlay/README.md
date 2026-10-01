# <project-code> agent skills (overlay)

Private, engagement-only skills for **<project-code>**. Start a new overlay by copying this folder into a
new **private** repository that only the engagement team can read.

## Rules

- Skills here are named `<project-code>-<name>` and never reuse a core skill name.
- Skills here may depend on core `agent-skills` skills. Core never depends on anything here.
- Client names are allowed here, secrets never are. CI runs `scrub-scan --secrets-only`.
- `.scrub/denylist.txt` lists this client's names and identifiers. Whoever writes the first
  client-specific skill creates it; everyone after keeps it current. It is what the core repo's scanner
  uses when a skill from here is promoted.
- When the engagement ends, archive or delete this repo as the client contract requires.

## Using it

```bash
# core first, then this overlay, for the same agent
(cd ../agent-skills && npm run link -- --agent <agent>)
node ../agent-skills/scripts/link.mjs --agent <agent>   # see README in core for overlay linking
```

## Promoting a skill to core

1. Copy the generic part into the core repo under `skills/<scope>/`, renamed without the project prefix.
2. Scrub it, scanning with this repo's denylist:
   `node scripts/scrub-scan.mjs --denylist ../<this-repo>/.scrub/denylist.txt skills/<scope>/<name>.md`
3. Open the core pull request. The overlay lead confirms the scrub; the core owner approves.
4. Make the overlay skill depend on the new core skill instead of duplicating it.
