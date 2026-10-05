#!/usr/bin/env node
// Create a correctly labelled draft skill from the template, so nobody fills in frontmatter by hand.
//
// Core skill:     node scripts/new-skill.mjs --name checkout-review --description "..." [--applies-to sfra,storefront-next]
// Overlay skill:  node scripts/new-skill.mjs --name deploy-to-staging --overlay ../<code>-agent-skills --description "..."
// Options: --owner <github-handle>   (default: the signed-in gh user, else git user.name)
//          --agent <agent-id>        (default: claude-code; goes into agents-tested)
//          --dry-run                 (print the draft instead of writing it)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT, CORE_DIR, APPLIES_TO, loadSkills, loadOverlay, upstreamSkillNames } from './lib.mjs';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dry = args.includes('--dry-run');
const fail = (m) => { console.error(`new-skill: ${m}`); process.exit(1); };

let name = (arg('--name') || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
if (!name) fail('pass --name <short-kebab-name>');
const description = (arg('--description') || '').trim();
if (description.length < 60) fail('pass --description: one or two sentences saying what it does and when to use it (60+ characters)');
const appliesTo = (arg('--applies-to', 'any')).split(',').map((s) => s.trim()).filter(Boolean);
for (const a of appliesTo) if (!APPLIES_TO.includes(a)) fail(`--applies-to "${a}" must be one of ${APPLIES_TO.join(', ')}`);
const agent = arg('--agent', 'claude-code');

const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
// Owner = GitHub handle. Prefer an explicit git setting (set once per repo or machine with
// `git config github.user <handle>`), then the signed-in gh account, then git's user name.
const owner = arg('--owner') || sh('git', ['config', 'github.user']) || sh('gh', ['api', 'user', '--jq', '.login'])
  || sh('git', ['config', 'user.name']).replace(/\s+/g, '-').toLowerCase();
if (!owner) fail('could not work out your GitHub handle; pass --owner <handle>');

const ovDir = arg('--overlay');
const ov = ovDir ? loadOverlay(resolve(ovDir)) : null;
if (ovDir && !ov) fail(`${ovDir} is not an overlay repo (no overlay.json)`);
const code = ov?.config.project;
if (ov && !name.startsWith(`${code}-`)) name = `${code}-${name}`;

const taken = new Set([...loadSkills().map((s) => s.data?.name), ...upstreamSkillNames(), ...(ov ? ov.skills.map((s) => s.data?.name) : [])]);
if (taken.has(name)) fail(`"${name}" already exists (core, official or this overlay). Run find-skill and reuse or extend it.`);

const desc = ov && !new RegExp(`^Project ${code} only\\b`, 'i').test(description) ? `Project ${code} only: ${description}` : description;
const today = new Date().toISOString().slice(0, 10);
const frontmatter = [
  '---',
  `name: ${name}`,
  `description: ${JSON.stringify(desc)}`,
  ...(ov ? [`project: ${code}`] : []),
  `owner: ${owner}`,
  'version: 0.1.0',
  'status: draft',
  `applies-to: [${appliesTo.join(', ')}]`,
  'depends-on: []',
  `agents-tested: [${agent}]`,
  `last-reviewed: ${today}`,
  '---',
].join('\n');

const templatePath = ov
  ? (existsSync(join(ov.dir, 'skill-template.md')) ? join(ov.dir, 'skill-template.md') : join(ROOT, 'templates/overlay/skill-template.md'))
  : join(ROOT, 'templates/skill.md');
const body = readFileSync(templatePath, 'utf8')
  .replace(/^---[\s\S]*?\n---\n?/, '')
  .replace(/<project-code>-your-skill|your-skill-name/g, name)
  .replace(/<project-code>/g, code || '<project-code>');
const text = `${frontmatter}\n${body}`;

const target = ov ? join(ov.dir, 'skills', `${name}.md`) : join(CORE_DIR, `${name}.md`);
if (dry) { console.log(text); process.exit(0); }
if (existsSync(target)) fail(`${target} already exists`);
writeFileSync(target, text);
console.log(`Created ${ov ? target : relative(ROOT, target)} (status: draft)

Next:
  1. Replace the template text with the real steps.
  2. node scripts/scrub-scan.mjs ${ov ? '--secrets-only ' : ''}${ov ? target : relative(ROOT, target)}
  3. node scripts/validate.mjs${ov ? ` --overlay ${ov.dir}` : ''}
  4. Set status: active when it's ready, then ${ov ? `node scripts/build-overlay.mjs ${ov.dir}` : 'npm run build'} and open a pull request.`);
