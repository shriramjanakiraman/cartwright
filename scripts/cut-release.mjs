#!/usr/bin/env node
// Prepare a release (see GOVERNANCE.md and AGENTS.md). Does the mechanical part, then stops for review:
//   - on any branch other than hotfix/*: creates release/<x.y.z> from the latest origin/develop
//   - on a hotfix/* branch: prepares the release on that branch, in place
// Then: sets package.json to x.y.z, turns CHANGELOG "Unreleased" into "## [x.y.z] - <today>" (leaving a
// fresh empty Unreleased above it), rebuilds, runs every check and commits "Release x.y.z".
// It never pushes or opens the pull request; that step is for the person or agent to take after review.
//
// Usage: node scripts/cut-release.mjs [x.y.z]        (or: npm run release -- 0.6.0)
// Without a version it picks one from the CHANGELOG (scripts/next-version.mjs): patch for fixes only,
// minor for anything added or changed. It never picks a major; give that version explicitly.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';
import { cmp, nextVersion } from './next-version.mjs';

let V = process.argv[2];
const fail = (m) => { console.error(`release: ${m}`); process.exit(1); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cmd, a) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit' });

if (V && !/^\d+\.\d+\.\d+$/.test(V)) fail(`'${V}' isn't a version like 0.6.0`);

if (git('status', '--porcelain')) fail('you have uncommitted changes; commit or stash them first');
try { git('fetch', '-q', '--tags', 'origin'); } catch { fail('could not fetch origin; check your GitHub access'); }

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
const hotfix = branch.startsWith('hotfix/');
const base = hotfix ? 'HEAD' : 'origin/develop';
if (!V) {
  const n = nextVersion(base);
  if (n.bump === 'none') fail(`nothing to release: ${n.reason}`);
  if (n.bump === 'owner') fail(`choose the version yourself (npm run release -- <x.y.z>): ${n.reason}`);
  V = n.version;
  console.log(`Releasing ${V}: ${n.bump} from ${n.base}, ${n.reason}`);
}
const rel = `release/${V}`;

// Validate everything against the base before creating anything, so a refusal leaves no stray branch.
const pkg = JSON.parse(git('show', `${base}:package.json`));
if (cmp(V, pkg.version) <= 0) fail(`${V} isn't newer than the current version ${pkg.version}`);
const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean).map((t) => t.slice(1)).filter((t) => /^\d+\.\d+\.\d+$/.test(t));
const latest = tags.sort(cmp).pop();
if (latest && cmp(V, latest) <= 0) fail(`${V} isn't newer than the latest release v${latest}`);
const cl = git('show', `${base}:CHANGELOG.md`) + '\n';
const m = cl.match(/^## \[Unreleased\]\n([\s\S]*?)(?=^## \[)/m);
if (!m) fail('CHANGELOG.md has no "## [Unreleased]" section followed by an earlier release');
if (!m[1].trim()) fail('the Unreleased section in CHANGELOG.md is empty; there is nothing to release');
if (new RegExp(`^## \\[${V.replace(/\./g, '\\.')}\\]`, 'm').test(cl)) fail(`CHANGELOG.md already has a ${V} section`);
if (!hotfix) {
  let exists = true;
  try { git('show-ref', '-q', '--verify', `refs/remotes/origin/${rel}`); } catch { exists = false; }
  if (exists) fail(`${rel} already exists on origin`);
  git('checkout', '-q', '-b', rel, 'origin/develop');
  console.log(`On ${rel} (from origin/develop)`);
} else {
  console.log(`Preparing the release on ${branch}`);
}

const pkgPath = join(ROOT, 'package.json');
const clPath = join(ROOT, 'CHANGELOG.md');
const today = new Date().toISOString().slice(0, 10);
writeFileSync(clPath, readFileSync(clPath, 'utf8').replace(/^## \[Unreleased\]\n/m, `## [Unreleased]\n\n## [${V}] - ${today}\n`));

pkg.version = V;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

run('node', ['scripts/build.mjs']);
run('node', ['scripts/validate.mjs']);
run('node', ['scripts/scrub-scan.mjs']);
run('node', ['scripts/build.mjs', '--check']);
git('add', '-A');
git('commit', '-q', '-m', `Release ${V}`);

const head = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log(`\nCommitted "Release ${V}" on ${head}. Review it, then:
  git push -u origin ${head}
  gh pr create --base main --title "Release ${V}"
Merging that pull request tags v${V}, publishes the notes and opens the main → develop sync.`);
