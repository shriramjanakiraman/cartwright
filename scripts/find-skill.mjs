#!/usr/bin/env node
// Find existing skills before writing a new one. Searches names and descriptions across our core skills,
// every bundled official skill, and optionally a project overlay.
//
// Usage: node scripts/find-skill.mjs "checkout payment failures"
//        node scripts/find-skill.mjs "deploy cartridges" --overlay ../<code>-agent-skills
//        node scripts/find-skill.mjs "import set" --json
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSkills, loadUpstreamSkills, loadOverlay, parseFrontmatter } from './lib.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const ov = args.includes('--overlay') ? loadOverlay(resolve(args[args.indexOf('--overlay') + 1])) : null;
const query = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--overlay').join(' ').trim();
if (!query) { console.error('Usage: node scripts/find-skill.mjs "<what the skill would do>"'); process.exit(2); }

const STOP = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'with', 'my', 'our', 'skill', 'how', 'do', 'i', 'we', 'that', 'this']);
const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

const candidates = [];
for (const s of loadSkills()) if (s.data) candidates.push({ where: 'core', name: s.data.name, status: s.data.status, description: s.data.description, path: s.rel });
for (const u of loadUpstreamSkills()) {
  const p = join(u.dir, 'SKILL.md');
  const d = existsSync(p) ? parseFrontmatter(readFileSync(p, 'utf8')).data || {} : {};
  candidates.push({ where: `official · ${u.set}`, name: u.name, status: 'bundled', description: String(d.description || ''), path: `upstream/${u.source}/${u.name}/SKILL.md` });
}
if (ov) for (const s of ov.skills) if (s.data) candidates.push({ where: `overlay · ${ov.config.project}`, name: s.data.name, status: s.data.status, description: s.data.description, path: s.path });

// Each query word counts once: 3 if it's in the name, 1 if only in the description. Single-word
// coincidences (score 1) are noise and are dropped; 4+ is a likely duplicate worth reading first.
const score = (c) => {
  const name = c.name.toLowerCase(), desc = String(c.description).toLowerCase();
  let n = 0, matched = 0;
  for (const w of words) {
    if (name.includes(w)) { n += 3; matched++; } else if (desc.includes(w)) { n += 1; matched++; }
  }
  return { n, matched };
};
const hits = candidates.map((c) => { const s = score(c); return { ...c, score: s.n, matched: s.matched }; })
  .filter((c) => c.score >= 2 && (c.matched >= 2 || c.score >= 3))
  .sort((a, b) => b.score - a.score || b.matched - a.matched || a.name.localeCompare(b.name)).slice(0, 8);

if (json) { console.log(JSON.stringify(hits, null, 2)); process.exit(0); }
console.log(`Searched ${candidates.length} skills for: ${words.join(', ') || query}\n`);
if (!hits.length) { console.log('No existing skill matches. A new one is reasonable.'); process.exit(0); }
for (const h of hits) {
  console.log(`  ${h.score >= 4 ? 'LIKELY ' : 'possible'}  ${h.name}  [${h.where}]  score ${h.score}`);
  console.log(`    ${String(h.description).replace(/\s+/g, ' ').slice(0, 160)}`);
}
console.log('\nRead the top matches before writing anything. If one already does the job, use it instead.');
