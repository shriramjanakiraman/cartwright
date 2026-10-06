# Scrubbing

Everything in this repo reaches every developer who installs the library. The scrub stops one client's
information, or anyone's secrets, from going with it. The full list of what must never appear, and the
placeholders to use instead, is in [CONTRIBUTING.md](../CONTRIBUTING.md#3-scrub).

## Scrub before the first commit

Removing a leak in a later commit leaves it in git history. If something leaks, tell the owner straight
away and follow the incident steps in [GOVERNANCE.md](../GOVERNANCE.md#incidents); don't try to fix it with
a new commit.

## The scanner

```bash
node scripts/scrub-scan.mjs                       # the whole repo
node scripts/scrub-scan.mjs core/<name>.md        # specific files
node scripts/scrub-scan.mjs --denylist ../<code>-agent-skills/.scrub/denylist.txt core/<name>.md
node scripts/scrub-scan.mjs --secrets-only <files>  # overlays: client names allowed, secrets never
```

It looks for two kinds of problem:

- **Secrets:** private keys, GitHub, AWS and Slack tokens, JWTs, and hard-coded passwords or API keys.
- **Leaks:** B2C instance and Demandware hostnames, org IDs, SCAPI short codes, client and tenant IDs,
  email addresses, Atlassian sites, ticket keys, absolute home-folder paths and IP addresses.

Each finding names the file, line and rule. Replace the value with a placeholder such as `<client>`,
`<instance-host>`, `<site-id>` or `<ticket-key>` and scan again until it's clean. Then read the text
yourself: the scanner can't recognise a client's business rules.

## Client denylists

Each overlay repo keeps `.scrub/denylist.txt`: this client's names, brands, cartridge prefixes, site IDs,
hostnames and people, one per line (lines starting with `#` are ignored). Scanning with `--denylist` flags
any of those words, case-insensitively. It's used whenever a skill moves from an overlay to core.

A missing or empty denylist is an **error**, so a scan can't pass without checking a single client name.
Whoever writes a client's first skill creates the list; everyone after keeps it current. It never leaves
the overlay repo.

You can also keep a personal `.scrub/denylist.local.txt` in this repo (git-ignored); the scanner reads it
automatically if it exists.

## Deliberate examples

A line that must contain something the scanner flags (for example, a sample of what not to do) can opt out
with `<!-- scrub:allow -->` on that line. Expect the reviewer to ask why. Never add it just to get past the
scanner.

## Where it runs

| Where | What |
|---|---|
| `pre-commit` hook (`npm run setup-hooks`) | scans the staged files and blocks the commit |
| CI on every pull request and push | scans the whole repo, plus a secret scan across git history (gitleaks) |
| Overlay CI | secrets-only scan of the overlay's skills |
| Releases | the release script scans before committing |
