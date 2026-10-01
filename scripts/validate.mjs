#!/usr/bin/env node
// Door B check: every core skill meets the standard in CONTRIBUTING.md.
// Usage: node scripts/validate.mjs
import {
  loadSkills, upstreamSkillNames, asList, fail,
  REQUIRED_FIELDS, REQUIRED_SECTIONS, SCOPES, STATUSES, APPLIES_TO,
} from './lib.mjs';

const skills = loadSkills();
const upstream = upstreamSkillNames();
const errors = [];
const seen = new Map();
const coreNames = new Set(skills.map((s) => s.data?.name).filter(Boolean));

for (const s of skills) {
  const d = s.data;
  const at = s.rel;
  if (!d) { errors.push(`${at}: missing frontmatter (--- block at the top)`); continue; }

  for (const f of REQUIRED_FIELDS) {
    if (d[f] === undefined || d[f] === '' || (Array.isArray(d[f]) && !d[f].length)) errors.push(`${at}: missing required field "${f}"`);
  }
  if (!SCOPES.includes(s.scope)) errors.push(`${at}: folder skills/${s.scope}/ is not a known scope (${SCOPES.join(', ')})`);
  if (d.name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.name)) errors.push(`${at}: name "${d.name}" must be kebab-case`);
    if (s.file !== `${d.name}.md`) errors.push(`${at}: filename must equal the skill name (${d.name}.md)`);
    if (seen.has(d.name)) errors.push(`${at}: name "${d.name}" already used by ${seen.get(d.name)}`);
    seen.set(d.name, at);
    if (upstream.has(d.name)) errors.push(`${at}: name "${d.name}" shadows an official upstream skill; pick another name or reference the official one`);
  }
  if (d.scope && d.scope !== s.scope) errors.push(`${at}: scope "${d.scope}" does not match its folder skills/${s.scope}/`);
  if (d.status && !STATUSES.includes(d.status)) errors.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
  if (d.version && !/^\d+\.\d+\.\d+$/.test(d.version)) errors.push(`${at}: version "${d.version}" must be semver (e.g. 1.0.0)`);
  if (d['last-reviewed'] && !/^\d{4}-\d{2}-\d{2}$/.test(d['last-reviewed'])) errors.push(`${at}: last-reviewed must be YYYY-MM-DD`);
  for (const a of asList(d['applies-to'])) {
    if (!APPLIES_TO.includes(a)) errors.push(`${at}: applies-to "${a}" must be one of ${APPLIES_TO.join(', ')}`);
  }
  if (d.description && d.description.length < 60) errors.push(`${at}: description is too short to say what the skill does and when to use it`);

  // One-way dependency rule: core may depend on core, upstream, or tools, never on project overlays.
  for (const dep of asList(d['depends-on'])) {
    if (dep.startsWith('tool:')) continue;
    if (!coreNames.has(dep) && !upstream.has(dep)) errors.push(`${at}: depends-on "${dep}" is not a core skill, an upstream skill in upstream.lock.json, or a "tool:" entry`);
  }

  for (const sec of REQUIRED_SECTIONS) {
    if (!new RegExp(`^##\\s+${sec}\\b`, 'mi').test(s.body)) errors.push(`${at}: missing required section "## ${sec}"`);
  }
  if (/\.\.\/overlay|overlay-repo|project-overlay/i.test(s.body)) errors.push(`${at}: core skills must not reference project overlay repos`);
}

if (fail(errors, 'validate')) process.exit(1);
console.log(`validate: ${skills.length} skill(s) OK`);
