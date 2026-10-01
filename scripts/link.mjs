#!/usr/bin/env node
// Door B for agents without a plugin manager: link every active skill into an agent's skill directory.
// Idempotent. Safe to re-run after every pull: it adds new skills and removes links to skills that were
// deleted or deprecated. It never touches anything that does not point into this repo.
//
// Usage:
//   node scripts/link.mjs --agent cursor                    # global (user) scope, common + sfcc
//   node scripts/link.mjs --agent codex --scope project --project-dir ../my-repo
//   node scripts/link.mjs --agent claude-code --only common
//   node scripts/link.mjs --agent windsurf --dry-run
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, loadSkills } from './lib.mjs';

const DIRS = {
  'claude-code':      { global: '~/.claude/skills', project: '.claude/skills' },
  cursor:             { global: '~/.cursor/skills', project: '.cursor/skills' },
  vscode:             { global: '~/.copilot/skills', project: '.github/skills' },
  codex:              { global: '~/.codex/skills', project: '.codex/skills' },
  windsurf:           { global: '~/.codeium/windsurf/skills', project: '.windsurf/skills' },
  opencode:           { global: '~/.config/opencode/skills', project: '.opencode/skills' },
  'agentforce-vibes': { global: null, project: '.a4drules/skills' },
  manual:             { global: '~/.agents/skills', project: '.agents/skills' },
};

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const agent = arg('--agent');
const scope = arg('--scope', 'global');
const only = arg('--only');
const dry = process.argv.includes('--dry-run');
if (!DIRS[agent]) { console.error(`--agent must be one of: ${Object.keys(DIRS).join(', ')}`); process.exit(2); }
const base = DIRS[agent][scope];
if (!base) { console.error(`${agent} has no ${scope}-scope skill directory; use --scope project`); process.exit(2); }
const target = scope === 'global' ? base.replace(/^~/, homedir()) : resolve(arg('--project-dir', '.'), base);

const wanted = loadSkills().filter((s) => s.data?.status === 'active' && (!only || s.scope === only));
const want = new Map(wanted.map((s) => [s.data.name, s.path]));
const act = (msg, fn) => { console.log(`${dry ? '[dry-run] ' : ''}${msg}`); if (!dry) fn(); };

if (!dry) mkdirSync(target, { recursive: true });
let added = 0, kept = 0, removed = 0;
for (const [name, src] of want) {
  const link = join(target, name, 'SKILL.md');
  if (existsSync(link) && lstatSync(link).isSymbolicLink() && readlinkSync(link) === src) { kept++; continue; }
  if (existsSync(link) && !lstatSync(link).isSymbolicLink()) { console.warn(`skip ${name}: ${link} is a real file, not ours`); continue; }
  act(`link   ${name}`, () => { mkdirSync(join(target, name), { recursive: true }); rmSync(link, { force: true }); symlinkSync(src, link); });
  added++;
}
if (existsSync(target)) for (const d of readdirSync(target)) {
  const link = join(target, d, 'SKILL.md');
  try {
    if (!lstatSync(link).isSymbolicLink()) continue;
    const dest = readlinkSync(link);
    if (dest.startsWith(join(ROOT, 'skills')) && !want.has(d)) { act(`unlink ${d}`, () => rmSync(join(target, d), { recursive: true })); removed++; }
  } catch { /* not a skill folder */ }
}
console.log(`\n${agent} (${scope}) → ${target}\n  ${added} linked, ${kept} already current, ${removed} removed`);
