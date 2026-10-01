# Scrub configuration

The core repo holds **no client names**. Client-name denylists live in each project's private overlay repo at
`.scrub/denylist.txt`, created by whoever writes that project's first client-specific skill.

To scan a skill you are promoting from a project into core, point the scanner at that project's list:

    node scripts/scrub-scan.mjs --denylist ../<overlay-repo>/.scrub/denylist.txt skills/common/<skill>.md

For a personal list you want applied to every local scan, create `.scrub/denylist.local.txt` (git-ignored).
