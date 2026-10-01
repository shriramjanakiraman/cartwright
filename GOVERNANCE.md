# Governance

## Ownership

| Area | Owner | Approves |
|---|---|---|
| Core repo (`skills/`, scripts, standards) | @shriramjanakiraman | Every pull request |
| Door A pull requests (upstream changes) | @shriramjanakiraman | Every lock update |
| Project overlay repos | @shriramjanakiraman or that engagement's named leads | Changes in that overlay |
| Promotions from an overlay into core | @shriramjanakiraman | The core pull request, after the overlay lead confirms the scrub |

Ownership is recorded in `.github/CODEOWNERS`. When more owners join, add them there and here in the
same pull request.

## Visibility

The core repo is **private** while the library is being piloted. Overlay repos are always private and
limited to the engagement team.

## Releases

- `package.json` holds the version. Bump it in any pull request that changes what users receive.
- Every release has a `CHANGELOG.md` entry.
- Tag releases `vX.Y.Z`. The release workflow publishes the matching CHANGELOG section as release notes.
- Users receive releases through the plugin manager, `npm run link`, and the `check-updates` nudge.

## Review cadence

- **Weekly**, automatically: the upstream check (Door A).
- **Quarterly**: review every `active` skill. Update `last-reviewed`, or deprecate what is no longer used
  or is now covered upstream.

## Engagement end

When an engagement ends, its overlay repo is archived or deleted as the client contract requires. Anything
worth keeping must already have been promoted to core through a scrubbed pull request.

## Incidents

If client data or a secret reaches this repo:

1. Tell the owner immediately. Don't try to fix it with a new commit.
2. Rotate any exposed secret.
3. The owner rewrites history and force-pushes, then asks everyone with a clone to re-clone.
4. Add the leaked pattern to the scanner so it can't recur.
