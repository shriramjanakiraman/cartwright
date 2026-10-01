#!/usr/bin/env node
// Door B for agents without a plugin manager: give an agent the same skills the plugin delivers
// (our core skills + every bundled official skill) by linking each built skill folder into the agent's
// skill directory. Idempotent: re-run after every pull to add new skills and remove ones that were
// deleted or deprecated. It only ever removes links that point into the source it is linking from.
//
// Usage:
//   node scripts/link.mjs --agent cursor                    # global (user) scope
//   node scripts/link.mjs --agent codex --scope project --project-dir ../my-repo
//   node scripts/link.mjs --agent windsurf --dry-run
//   node scripts/link.mjs --agent cursor --from ../<overlay-repo>   # a project overlay's skills/ folder
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, parseFrontmatter } from './lib.mjs';

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
const from = arg('--from');
const dry = process.argv.includes('--dry-run');
if (!DIRS[agent]) { console.error(`--agent must be one of: ${Object.keys(DIRS).join(', ')}`); process.exit(2); }
const base = DIRS[agent][scope];
if (!base) { console.error(`${agent} has no ${scope}-scope skill directory; use --scope project`); process.exit(2); }
const target = scope === 'global' ? base.replace(/^~/, homedir()) : resolve(arg('--project-dir', '.'), base);
if (agent === 'claude-code' && !from) console.warn('Tip: Claude Code users get the same skills, plus auto-update and the MCP server, by installing the plugin instead.');

// want: name -> { link path inside target, link destination }
const want = new Map();
let sourceRoot;
if (from) {
  // Project overlay: flat skills/*.md; a missing status counts as active. Linked per file.
  sourceRoot = resolve(from, 'skills');
  if (!existsSync(sourceRoot)) { console.error(`no skills/ folder in ${from}`); process.exit(2); }
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f);
    if (lstatSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.md')) { const { data } = parseFrontmatter(readFileSync(p, 'utf8'));
      if (data?.name && (data.status || 'active') === 'active') want.set(data.name, { at: join(target, data.name, 'SKILL.md'), to: p }); } } };
  walk(sourceRoot);
} else {
  // Core: link each built skill folder (keeps official skills' references/ and scripts working).
  sourceRoot = join(ROOT, 'plugin', 'skills');
  if (!existsSync(sourceRoot)) { console.error('plugin/skills is missing. Run "npm run build" first.'); process.exit(2); }
  for (const name of readdirSync(sourceRoot)) want.set(name, { at: join(target, name), to: join(sourceRoot, name) });
}

const act = (msg, fn) => { console.log(`${dry ? '[dry-run] ' : ''}${msg}`); if (!dry) fn(); };
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

if (!dry) mkdirSync(target, { recursive: true });
let added = 0, kept = 0, removed = 0, skipped = 0;
for (const [name, { at, to }] of want) {
  if (isLink(at) && readlinkSync(at) === to) { kept++; continue; }
  if (exists(at) && !isLink(at)) { console.warn(`skip   ${name}: ${at} already exists and is not ours`); skipped++; continue; }
  act(`link   ${name}`, () => { mkdirSync(join(at, '..'), { recursive: true }); rmSync(at, { force: true }); symlinkSync(to, at); });
  added++;
}
// Prune links that point into this source but are no longer wanted.
if (existsSync(target)) for (const d of readdirSync(target)) {
  for (const p of [join(target, d), join(target, d, 'SKILL.md')]) {
    if (!isLink(p)) continue;
    if (readlinkSync(p).startsWith(sourceRoot) && !want.has(d)) {
      act(`unlink ${d}`, () => rmSync(p === join(target, d) ? p : join(target, d), { recursive: true, force: true }));
      removed++;
    }
  }
}
console.log(`\n${agent} (${scope}) → ${target}\n  ${added} linked, ${kept} already current, ${removed} removed${skipped ? `, ${skipped} skipped (name already taken)` : ''}`);
