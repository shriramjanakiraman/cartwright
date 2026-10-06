#!/usr/bin/env node
// Duplicate check: is a new or changed skill a repeat of one that already exists? Offline: compares names
// and descriptions (what agents choose skills by) with TF-IDF cosine similarity. No data leaves the repo.
//
// What each skill is compared against (see GOVERNANCE.md):
//   core skill     → core + official skills
//   overlay skill  → that overlay + core + official skills   (core never sees overlays, overlays never
//                                                             see each other)
//   official skill → core skills only (used by upstream-watch: does a new official skill repeat ours?)
// Skills a skill lists in depends-on (in either direction) are never flagged: building on one is intended.
// Deprecated skills are ignored on both sides.
//
// Usage: node scripts/similar-skills.mjs [--overlay <repo>] [--base <git-ref>] [--json | --markdown] [files…]
//   files    skill files to check (core/<name>.md, skills/<name>.md in an overlay, upstream/…/SKILL.md)
//   --base   check the skill files changed since <git-ref> instead (in the overlay repo with --overlay)
// Exits 0 with nothing found, 1 when there are likely repeats (they're printed), 2 on bad usage.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, loadSkills, loadUpstreamSkills, loadOverlay, parseFrontmatter, asList } from './lib.mjs';

// At or above this score two skills probably do the same job. Calibrated on the bundled official skills:
// related-but-distinct pairs score up to about 0.40; rewrites of an existing skill score 0.45 and more.
// Set just below that so a reviewer sees the borderline cases too. Comments are for review, not verdicts.
export const THRESHOLD = 0.35;
const MAX_PER_SKILL = 3;
const STOP = new Set(('a an the to for of and or in on with is are be it its this that these use used uses using ' +
  'when whenever you your can if as by from at not any all also skill skills b2c commerce salesforce even ' +
  'just they them their need needs needed want wants like say says such into via only project what which ' +
  'how do does done should would will about after before then than there here more most other some one').split(' '));

const tokens = (s) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

// Every skill this check can see, from the point of view of `overlay` (or core when null).
export function corpus(overlay) {
  const all = [];
  const add = (where, kind, data, path) => {
    if (!data?.name) return;
    all.push({ where, kind, name: data.name, status: data.status || 'active', description: String(data.description || ''),
      deps: new Set(asList(data['depends-on'])), path });
  };
  for (const s of loadSkills()) add('core', 'core', s.data, s.path);
  for (const u of loadUpstreamSkills()) {
    const p = join(u.dir, 'SKILL.md');
    if (existsSync(p)) add(`official · ${u.set}`, 'official', parseFrontmatter(readFileSync(p, 'utf8')).data, p);
  }
  if (overlay) for (const s of overlay.skills) add(`overlay · ${overlay.config.project}`, 'overlay', s.data, s.path);
  return all.filter((s) => s.status !== 'deprecated');
}

function vectors(items, extraStop) {
  const tf = items.map((s) => {
    const m = new Map();
    for (const w of tokens(`${s.name.replace(/-/g, ' ')} ${s.description}`)) if (!extraStop.has(w)) m.set(w, (m.get(w) || 0) + 1);
    return m;
  });
  const df = new Map();
  for (const m of tf) for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
  const n = tf.length;
  return tf.map((m) => {
    const v = new Map(); let norm = 0;
    for (const [w, c] of m) { const x = (1 + Math.log(c)) * Math.log((n + 1) / df.get(w)); v.set(w, x); norm += x * x; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
}

function suggestion(a, b) {
  const nb = `\`${b.name}\``;
  if (a.kind === 'official') return `Salesforce now ships ${'`' + a.name + '`'}, which may do what our ${nb} does. If so, deprecate ours in favour of it; if ours adds something, make it build on the official one (add it to \`depends-on\`) and keep only the difference.`;
  if (b.kind === 'official') return `If it does the same job, use the official ${nb} instead (official skills aren't edited here). If it adds to it, build on it: add ${nb} to \`depends-on\` and keep only what's different.`;
  if (a.kind === 'overlay' && b.kind === 'core') return `If the generic part is the same, build on ${nb}: add it to \`depends-on\` and keep only what's specific to this client.`;
  if (b.kind === 'overlay') return `If it does the same job, improve ${nb} in this overlay instead, or combine the two into one skill.`;
  return `If it does the same job, improve ${nb} instead, or combine the two into one skill. If they're deliberately different, make the difference clear in both descriptions so agents pick the right one.`;
}

// Likely repeats for the skills at `paths` (absolute). Returns [{ skill, file, match, matchWhere, matchFile,
// score, shared, suggestion, key }], strongest first.
export function findSimilar(paths, overlay = null) {
  const all = corpus(overlay);
  const projectCode = overlay?.config.project;
  const vecs = vectors(all, new Set(projectCode ? [projectCode] : []));
  const base = overlay ? overlay.dir : ROOT;
  const out = [];
  for (const p of paths) {
    const i = all.findIndex((s) => resolve(s.path) === resolve(p));
    if (i < 0) continue;   // deleted, deprecated, or not a skill
    const a = all[i];
    const hits = [];
    all.forEach((b, j) => {
      if (j === i || b.name === a.name) return;
      if (a.kind === 'official' && b.kind !== 'core') return;
      if (a.kind === 'core' && b.kind === 'overlay') return;
      if (a.deps.has(b.name) || b.deps.has(a.name)) return;
      let score = 0; const shared = [];
      for (const [w, x] of vecs[i]) { const y = vecs[j].get(w); if (y) { score += x * y; shared.push([w, x * y]); } }
      if (score >= THRESHOLD) hits.push({ b, score, shared: shared.sort((m, n) => n[1] - m[1]).slice(0, 6).map(([w]) => w) });
    });
    for (const h of hits.sort((m, n) => n.score - m.score).slice(0, MAX_PER_SKILL)) {
      out.push({
        skill: a.name, official: a.kind === 'official', file: relative(a.kind === 'official' ? ROOT : base, a.path),
        match: h.b.name, matchWhere: h.b.where, matchFile: relative(h.b.kind === 'overlay' ? base : ROOT, h.b.path),
        score: Math.round(h.score * 100) / 100, shared: h.shared, suggestion: suggestion(a, h.b),
        key: [a.name, h.b.name].sort().join('~'),
      });
    }
  }
  // Two new skills that resemble each other would be reported from both sides; keep one per pair.
  const seen = new Set();
  return out.sort((m, n) => n.score - m.score).filter((f) => !seen.has(f.key) && seen.add(f.key));
}

// Skill files changed since `ref` in the repo at `dir` (core: core/*.md; overlay: skills/*.md).
export function changedSkillFiles(ref, dir = ROOT, overlay = false) {
  const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=AMR', ref, '--', overlay ? 'skills' : 'core'],
    { cwd: dir, encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.md'));
  return files.map((f) => join(dir, f));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };
  const ovDir = val('--overlay');
  const overlay = ovDir ? loadOverlay(resolve(ovDir)) : null;
  if (ovDir && !overlay) { console.error('similar-skills: no overlay.json found in that folder'); process.exit(2); }
  const skip = new Set([ovDir, val('--base')].filter(Boolean));
  const files = val('--base')
    ? changedSkillFiles(val('--base'), overlay ? overlay.dir : ROOT, !!overlay)
    : args.filter((a) => !a.startsWith('--') && !skip.has(a)).map((f) => resolve(f));
  const found = findSimilar(files, overlay);

  if (args.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (args.includes('--markdown')) {
    for (const f of found) {
      const what = f.official ? `Official \`${f.skill}\` may overlap our \`${f.match}\`` : `\`${f.skill}\` may repeat \`${f.match}\` (${f.matchWhere})`;
      console.log(`- [ ] ${what}: similarity ${f.score}; shared: ${f.shared.join(', ')}. ${f.suggestion}`);
    }
  } else {
    console.log(`Checked ${files.length} skill file(s) for repeats (threshold ${THRESHOLD}).`);
    for (const f of found) console.log(`\n  ${f.skill}  ~  ${f.match}  [${f.matchWhere}]  similarity ${f.score}\n    shared: ${f.shared.join(', ')}\n    ${f.suggestion}`);
    if (!found.length) console.log('No likely repeats.');
  }
  process.exit(found.length ? 1 : 0);
}
