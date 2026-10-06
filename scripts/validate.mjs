#!/usr/bin/env node
// Door B check: every skill meets the standard in CONTRIBUTING.md.
// Usage: node scripts/validate.mjs                      # core/
//        node scripts/validate.mjs --overlay ../<repo>  # a project overlay repo, with overlay rules
import { readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import {
  ROOT, loadSkills, loadOverlay, upstreamSkillNames, asList, fail,
  REQUIRED_FIELDS, REQUIRED_SECTIONS, STATUSES, APPLIES_TO,
} from './lib.mjs';

const ovIdx = process.argv.indexOf('--overlay');
const overlay = ovIdx > -1 ? loadOverlay(resolve(process.argv[ovIdx + 1])) : null;
if (ovIdx > -1 && !overlay) { console.error('validate: no overlay.json found in that folder'); process.exit(2); }

const errors = [];
const upstream = upstreamSkillNames();
const core = loadSkills();
const coreNames = new Set(core.map((s) => s.data?.name).filter(Boolean));
const code = overlay?.config.project;

// Stock text from the skill templates. An active skill still containing it was never filled in. The
// Constraints section is left out: its template lines are sensible defaults that skills may keep.
const stock = new Set();
for (const t of ['templates/skill.md', 'templates/overlay/skill-template.md']) {
  let skip = false;
  for (const line of readFileSync(join(ROOT, t), 'utf8').replace(/^---[\s\S]*?\n---\n/, '').split('\n')) {
    if (/^#/.test(line)) { skip = /^##\s+Constraints\b/i.test(line); continue; }
    if (!skip && line.trim().length > 25) stock.add(line.trim());
  }
}
if (overlay && !/^[a-z][a-z0-9]{1,15}$/.test(code || '')) errors.push(`overlay.json: "project" must be a short lowercase code (e.g. prja), got "${code}"`);

const skills = overlay ? overlay.skills : core;
const ownNames = new Set(skills.map((s) => s.data?.name).filter(Boolean));
const seen = new Map();
const where = (s) => (overlay ? relative(overlay.dir, s.path) : s.rel);

for (const s of skills) {
  const d = s.data;
  const at = where(s);
  if (!d) { errors.push(`${at}: missing frontmatter (--- block at the top)`); continue; }

  for (const f of [...REQUIRED_FIELDS, ...(overlay ? ['project'] : [])]) {
    if (d[f] === undefined || d[f] === '' || (Array.isArray(d[f]) && !d[f].length)) errors.push(`${at}: missing required field "${f}"`);
  }
  if (d.name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.name)) errors.push(`${at}: name "${d.name}" must be kebab-case`);
    if (s.file !== `${d.name}.md`) errors.push(`${at}: filename must equal the skill name (${d.name}.md)`);
    if (seen.has(d.name)) errors.push(`${at}: name "${d.name}" already used by ${seen.get(d.name)}`);
    seen.set(d.name, at);
    if (upstream.has(d.name)) errors.push(`${at}: name "${d.name}" is already an official skill bundled from upstream; don't duplicate it`);
    if (overlay && coreNames.has(d.name)) errors.push(`${at}: name "${d.name}" is already a core skill`);
    if (overlay && code && !d.name.startsWith(`${code}-`)) errors.push(`${at}: project skills must be named "${code}-…"`);
  }
  if (overlay) {
    if (d.project && d.project !== code) errors.push(`${at}: project "${d.project}" does not match overlay.json ("${code}")`);
    if (d.description && code && !new RegExp(`^Project ${code} only\\b`, 'i').test(d.description)) errors.push(`${at}: description must start with "Project ${code} only:" so agents know it is project-specific`);
  } else if (d.project) {
    errors.push(`${at}: core skills must not have a "project" field; project-specific skills belong in an overlay repo`);
  }
  if (d.status && !STATUSES.includes(d.status)) errors.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
  if (d.version && !/^\d+\.\d+\.\d+$/.test(d.version)) errors.push(`${at}: version "${d.version}" must be semver (e.g. 1.0.0)`);
  if (d['last-reviewed'] && !/^\d{4}-\d{2}-\d{2}$/.test(d['last-reviewed'])) errors.push(`${at}: last-reviewed must be YYYY-MM-DD`);
  for (const a of asList(d['applies-to'])) {
    if (!APPLIES_TO.includes(a)) errors.push(`${at}: applies-to "${a}" must be one of ${APPLIES_TO.join(', ')}`);
  }
  if (d.description && d.description.length < 60) errors.push(`${at}: description is too short to say what the skill does and when to use it`);

  // One-way dependency rule: core depends on core/upstream/tools only; overlays may also use their own skills.
  for (const dep of asList(d['depends-on'])) {
    if (dep.startsWith('tool:')) continue;
    const ok = coreNames.has(dep) || upstream.has(dep) || (overlay && ownNames.has(dep));
    if (!ok) errors.push(`${at}: depends-on "${dep}" is not a ${overlay ? 'skill in this overlay, a ' : ''}core skill, an upstream skill in upstream.lock.json, or a "tool:" entry`);
  }

  for (const sec of REQUIRED_SECTIONS) {
    if (!new RegExp(`^##\\s+${sec}\\b`, 'mi').test(s.body)) errors.push(`${at}: missing required section "## ${sec}"`);
  }
  if (!overlay && /\.\.\/overlay|overlay-repo|project-overlay/i.test(s.body)) errors.push(`${at}: core skills must not reference project overlay repos`);
  if (d.status === 'active') {
    const left = s.body.split('\n').map((l) => l.trim()).find((l) => stock.has(l));
    if (left) errors.push(`${at}: still has template text ("${left.slice(0, 60)}…"); fill it in, or keep status: draft`);
  }
}

if (fail(errors, `validate${overlay ? ` (overlay ${code})` : ''}`)) process.exit(1);
console.log(`validate${overlay ? ` (overlay ${code})` : ''}: ${skills.length} skill(s) OK`);
