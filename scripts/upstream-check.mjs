#!/usr/bin/env node
// Door A: compare upstream.lock.json with what the official publishers ship today.
//
// Usage:
//   node scripts/upstream-check.mjs                       # report only; exit 0 = current, 10 = changes found
//   node scripts/upstream-check.mjs --write               # also update upstream.lock.json
//   node scripts/upstream-check.mjs --report report.md    # write the markdown report to a file
//   node scripts/upstream-check.mjs --changelog           # also add the changes under CHANGELOG "Unreleased"
// The CHANGELOG entries drive the weekly release's version: version bumps and new official skills are a
// minor change; official skills removed upstream go under "Removed", so the owner decides on a major.
// Set GITHUB_TOKEN (or GH_TOKEN) to avoid API rate limits.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadLock, loadSkills, asList, addUnreleased } from './lib.mjs';

const args = process.argv.slice(2);
const write = args.includes('--write');
const reportPath = args.includes('--report') ? args[args.indexOf('--report') + 1] : null;
const changelog = args.includes('--changelog');
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

async function gh(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function latestTag(repo, prefix) {
  for (let page = 1; page <= 5; page++) {
    const rels = await gh(`repos/${repo}/releases?per_page=100&page=${page}`);
    const hit = rels.find((r) => !r.draft && !r.prerelease && (!prefix || r.tag_name.startsWith(prefix)));
    if (hit) return hit.tag_name;
    if (rels.length < 100) break;
  }
  throw new Error(`no release found for ${repo}${prefix ? ` with prefix ${prefix}` : ''}`);
}

async function skillsAt(repo, ref, src) {
  const tree = await gh(`repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const sets = {};
  for (const { path } of tree.tree) {
    for (const rule of src.skillPaths || []) {
      const m = path.match(new RegExp(rule.pattern));
      if (m) (sets[rule.set || m[1]] ||= []).push(rule.set ? m[1] : m[2]);
    }
  }
  for (const k of Object.keys(sets)) sets[k] = [...new Set(sets[k])].sort();
  return sets;
}

const lock = loadLock();
const next = structuredClone(lock);
const changes = [];

for (const [id, src] of Object.entries(lock.sources)) {
  try {
    let version = src.version;
    let ref;
    if (src.type === 'github-release') {
      const tag = await latestTag(src.repo, src.tagPrefix);
      version = src.tagPrefix ? tag.slice(src.tagPrefix.length) : tag;
      ref = tag;
    } else if (src.type === 'github-branch') {
      const c = await gh(`repos/${src.repo}/commits/${src.ref}`);
      version = undefined;
      ref = c.sha;
      if (c.sha !== src.sha) changes.push({ id, kind: 'version', from: src.sha?.slice(0, 7), to: c.sha.slice(0, 7) });
      next.sources[id].sha = c.sha;
    } else if (src.type === 'pypi') {
      const res = await fetch(`https://pypi.org/pypi/${src.package}/json`);
      version = (await res.json()).info.version;
    }
    if (src.type !== 'github-branch' && version !== src.version) changes.push({ id, kind: 'version', from: src.version, to: version });
    if (version) next.sources[id].version = version;

    if (src.skillPaths && ref) {
      const now = await skillsAt(src.repo, ref, src);
      const before = src.skills || {};
      for (const set of new Set([...Object.keys(before), ...Object.keys(now)])) {
        const a = new Set(before[set] || []), b = new Set(now[set] || []);
        const added = [...b].filter((x) => !a.has(x)), removed = [...a].filter((x) => !b.has(x));
        if (added.length || removed.length) changes.push({ id, kind: 'skills', set, added, removed });
      }
      next.sources[id].skills = now;
    }
  } catch (e) {
    changes.push({ id, kind: 'error', message: e.message });
  }
}
next.checkedAt = new Date().toISOString().slice(0, 10);

// Impact on our own skills: anything that depends on, or mentions, a changed upstream skill.
const ours = loadSkills().filter((s) => s.data);
const touched = new Set(changes.flatMap((c) => [...(c.added || []), ...(c.removed || [])]));
const impacted = ours.filter((s) => asList(s.data['depends-on']).some((d) => touched.has(d)) || [...touched].some((t) => s.body.includes(t)));
const newUpstream = changes.flatMap((c) => c.added || []);

const lines = [`# Upstream check — ${next.checkedAt}`, ''];
if (!changes.length) lines.push('All official sources match `upstream.lock.json`. Nothing to do.');
for (const c of changes) {
  if (c.kind === 'error') lines.push(`- ⚠️ **${c.id}**: check failed (${c.message})`);
  if (c.kind === 'version') lines.push(`- **${c.id}**: \`${c.from ?? 'none'}\` → \`${c.to}\``);
  if (c.kind === 'skills') {
    if (c.added.length) lines.push(`- **${c.id} / ${c.set}**: added ${c.added.map((x) => `\`${x}\``).join(', ')}`);
    if (c.removed.length) lines.push(`- **${c.id} / ${c.set}**: removed ${c.removed.map((x) => `\`${x}\``).join(', ')}`);
  }
}
if (changes.some((c) => c.kind !== 'error')) {
  lines.push('', '## Review before merging', '');
  lines.push(impacted.length
    ? `Our skills that reference a changed upstream skill:\n${impacted.map((s) => `- [ ] \`${s.data.name}\` (${s.rel})`).join('\n')}`
    : '- [ ] No core skill references a changed upstream skill.');
  if (newUpstream.length) lines.push('', `- [ ] New official skills (${newUpstream.map((x) => `\`${x}\``).join(', ')}): check none of ours now duplicates them. If one does, deprecate ours.`);
  lines.push('- [ ] Version bumps: check the skills that install these tools still work against the new version.');
  lines.push('', '**Release:** the CHANGELOG entry under *Unreleased* is written for you (edit it in a follow-up pull request if it should say more). Don\'t change `package.json`; the weekly release sets the version.');
  if (changes.some((c) => c.removed?.length)) lines.push('Official skills were removed, so this is recorded under *Removed*: the weekly release will ask the owner whether it needs a major version.');
}
const report = lines.join('\n') + '\n';
if (reportPath) writeFileSync(reportPath, report);
console.log(report);

if (write) writeFileSync(join(ROOT, 'upstream.lock.json'), JSON.stringify(next, null, 2) + '\n');
if (changelog && changes.some((c) => c.kind !== 'error')) {
  const code = (xs) => xs.map((x) => `\`${x}\``).join(', ');
  const bumps = changes.filter((c) => c.kind === 'version').map((c) => `${c.id} ${c.from ?? 'none'} → ${c.to}`);
  const sets = changes.filter((c) => c.kind === 'skills');
  const p = join(ROOT, 'CHANGELOG.md');
  writeFileSync(p, addUnreleased(readFileSync(p, 'utf8'), {
    Added: sets.filter((c) => c.added.length).map((c) => `Official skills from ${c.id} (${c.set}): ${code(c.added)}.`),
    Changed: bumps.length ? [`Official sources updated: ${bumps.join('; ')}.`] : [],
    Removed: sets.filter((c) => c.removed.length).map((c) => `Official skills removed upstream from ${c.id} (${c.set}): ${code(c.removed)}.`),
  }));
}
process.exit(changes.some((c) => c.kind !== 'error') ? 10 : 0);
