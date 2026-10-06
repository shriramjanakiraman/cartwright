#!/usr/bin/env node
// Decide the next release version from CHANGELOG.md's Unreleased section (see GOVERNANCE.md):
//   - only Fixed / Security entries                  → patch (0.5.0 → 0.5.1)
//   - anything else (Added, Changed, Deprecated, …)  → minor (0.5.0 → 0.6.0)
//   - Removed entries, or an entry starting BREAKING → no version: a major release is the owner's call
// The base is the newer of the current version (package.json, or overlay.json in an overlay repo) and the
// latest v* tag.
//
// Usage: node scripts/next-version.mjs [--ref <git-ref>] [--overlay <overlay-repo>]
//   --ref defaults to the working tree; --overlay reads that overlay repo instead of this one.
// Prints the version and exits 0; exits 3 when there's nothing to release; exits 4 when the owner must
// decide (the reason is printed to stderr).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib.mjs';

const PATCH_ONLY = new Set(['fixed', 'security']);
const OWNER_DECIDES = new Set(['removed']);

export const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

// Returns { bump: 'none' | 'patch' | 'minor' | 'owner', reason }.
export function classify(changelog) {
  const m = (changelog + '\n').match(/^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m);
  if (!m) return { bump: 'owner', reason: 'CHANGELOG.md has no "## [Unreleased]" section' };
  let heading = null, entries = 0, features = 0;
  for (const line of m[1].split('\n')) {
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) { heading = h[1].toLowerCase(); continue; }
    if (!line.trim()) continue;
    if (!/^\s*[-*]\s/.test(line)) continue;   // continuation lines belong to the entry above
    if (/^\s*[-*]\s+(\*\*)?BREAKING\b/.test(line)) return { bump: 'owner', reason: 'an Unreleased entry is marked BREAKING' };
    entries++;
    if (heading && OWNER_DECIDES.has(heading)) return { bump: 'owner', reason: `Unreleased has "${h1(heading)}" entries; removing something can break existing use` };
    if (!heading || !PATCH_ONLY.has(heading)) features++;
  }
  if (!entries) return { bump: 'none', reason: 'the Unreleased section in CHANGELOG.md is empty' };
  return features ? { bump: 'minor', reason: `${features} added or changed entr${features === 1 ? 'y' : 'ies'}` }
    : { bump: 'patch', reason: `only fixes (${entries} entr${entries === 1 ? 'y' : 'ies'})` };
}
const h1 = (s) => s[0].toUpperCase() + s.slice(1);

export function bump(version, kind) {
  const [maj, min, pat] = version.split('.').map(Number);
  return kind === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

// Everything needed to pick a version at a git ref (or the working tree when ref is empty), in this repo
// or, with dir, in an overlay repo (whose version lives in overlay.json).
export function nextVersion(ref, dir = ROOT) {
  const versionFile = dir === ROOT ? 'package.json' : 'overlay.json';
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const read = (f) => (ref ? git('show', `${ref}:${f}`) : readFileSync(join(dir, f), 'utf8'));
  const tags = git('tag', '--list', 'v*').split('\n').map((t) => t.slice(1)).filter((t) => /^\d+\.\d+\.\d+$/.test(t)).sort(cmp);
  const pkg = JSON.parse(read(versionFile)).version;
  const base = tags.length && cmp(tags.at(-1), pkg) > 0 ? tags.at(-1) : pkg;
  const c = classify(read('CHANGELOG.md'));
  return { ...c, base, version: c.bump === 'patch' || c.bump === 'minor' ? bump(base, c.bump) : null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : ''; };
  const r = nextVersion(arg('--ref'), arg('--overlay') ? resolve(arg('--overlay')) : ROOT);
  if (r.bump === 'none') { console.error(`next-version: nothing to release: ${r.reason}`); process.exit(3); }
  if (r.bump === 'owner') { console.error(`next-version: the owner must choose the version: ${r.reason}`); process.exit(4); }
  console.error(`next-version: ${r.bump} release from ${r.base}: ${r.reason}`);
  console.log(r.version);
}
