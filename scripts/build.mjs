#!/usr/bin/env node
// Door B distribution. Builds everything a user receives from one install:
//   plugin/skills/<name>/              our active core skills + every mirrored official skill
//   plugin/.mcp.json                   the official B2C MCP server, at the pinned version
//   plugin/licenses/                   each upstream publisher's licence (Apache-2.0 attribution)
//   .claude-plugin/marketplace.json    so the repo installs as a Claude Code plugin marketplace
//   plugin/.codex-plugin/plugin.json   the same plugin for Codex (skills/ and .mcp.json are shared)
//   .agents/plugins/marketplace.json   so the repo installs as a Codex plugin marketplace
//   plugin/plugin.json, plugin/mcp.json  the manifest and MCP file GitHub Copilot CLI and VS Code read, in
//                                      Copilot's format; Claude Code and Codex use their own manifests above
//   plugin/tools/                      client setup helper (setup.mjs, kit.mjs, registry-core.mjs), the
//                                      encrypted overlay registry (registry.json), run.mjs with the
//                                      pinned tool versions (versions.json) to run tools without installing,
//                                      the project profiler (profile.mjs, stacks/, store.mjs, settings.mjs,
//                                      secret-rules.mjs) and the guard (guard.mjs, guard-rules.mjs, guard-shell.mjs)
//   plugin/hooks/hooks.json            session-start hook (offers client setup in projects not yet set up) and
//                                      the PreToolUse guardrail hook (tools/guard.mjs)
//   INDEX.md                           the human catalogue
// Drafts and deprecated core skills are left out of the plugin but listed in INDEX.md.
//
// Usage: node scripts/build.mjs           # write
//        node scripts/build.mjs --check   # CI: fail if the committed output is stale
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, UPSTREAM_DIR, loadSkills, loadUpstreamSkills, loadLock, asList } from './lib.mjs';

const check = process.argv.includes('--check');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = loadLock();
const skills = loadSkills().filter((s) => s.data);
const shipped = skills.filter((s) => s.data.status === 'active');
const official = loadUpstreamSkills();

const clash = shipped.filter((s) => official.some((o) => o.name === s.data.name));
if (clash.length) { console.error(`build: core skill name(s) clash with official skills: ${clash.map((s) => s.data.name).join(', ')}`); process.exit(1); }

const out = new Map(); // relative path -> Buffer | string

out.set('.claude-plugin/marketplace.json', JSON.stringify({
  name: 'cartwright',
  owner: { name: pkg.author },
  plugins: [{ name: 'cartwright', description: pkg.description, version: pkg.version, source: './plugin' }],
}, null, 2) + '\n');

out.set('plugin/.claude-plugin/plugin.json', JSON.stringify({
  name: 'cartwright', version: pkg.version, description: pkg.description, author: { name: pkg.author },
}, null, 2) + '\n');

// MCP servers the plugin registers, pinned to the versions in the lock.
const servers = {};
for (const src of Object.values(lock.sources)) {
  if (src.mcpServer && src.version) servers[src.mcpServer.name] = { command: 'npx', args: ['-y', `${src.mcpServer.package}@${src.version}`] };
}
if (Object.keys(servers).length) out.set('plugin/.mcp.json', JSON.stringify({ mcpServers: servers }, null, 2) + '\n');

// Client setup: the helper the hook and the client-setup skill call, with the code it needs and the
// registry, so it runs from the installed plugin with nothing else on the machine but node and git.
for (const f of ['setup.mjs', 'kit.mjs', 'registry-core.mjs', 'run.mjs']) out.set(`plugin/tools/${f}`, readFileSync(join(ROOT, 'scripts', f), 'utf8'));
// The project profiler and what it shares with the session-start hook and the guard: storage, settings and
// their merge rules, the secret patterns, and one module per stack.
for (const f of ['profile.mjs', 'store.mjs', 'settings.mjs', 'secret-rules.mjs', 'guard.mjs', 'guard-rules.mjs', 'guard-shell.mjs']) out.set(`plugin/tools/${f}`, readFileSync(join(ROOT, 'scripts', f), 'utf8'));
for (const f of readdirSync(join(ROOT, 'scripts', 'stacks')).filter((n) => n.endsWith('.mjs')).sort()) out.set(`plugin/tools/stacks/${f}`, readFileSync(join(ROOT, 'scripts', 'stacks', f), 'utf8'));
// The versions run.mjs fetches when a tool isn't installed: the ones pinned in the lock.
out.set('plugin/tools/versions.json', JSON.stringify(Object.fromEntries(Object.entries(lock.sources).filter(([, s]) => s.version).map(([id, s]) => [id, s.version])), null, 2) + '\n');
out.set('plugin/tools/registry.json', readFileSync(join(ROOT, 'registry', 'overlays.json'), 'utf8'));
// One session-start hook in the format Claude Code, Codex, Copilot and VS Code all read. Every one of them sets a
// plugin-root variable (Claude Code and VS Code CLAUDE_PLUGIN_ROOT, Codex PLUGIN_ROOT, Copilot all three), then the
// plugin-root cache the hook itself writes, as the guard's entry does; no search of the install caches. It never fails
// a session: no node, no plugin found, or an error all end silently.
// FROZEN from the end of phase 1 (decision record 0012): Codex trusts a hook by a hash of its entry, so any change to
// either entry (command, matcher, timeout, order) asks every Codex user to approve the hooks again.
const HOOK = 'command -v node >/dev/null 2>&1 || exit 0; '
  + 'for d in "$CLAUDE_PLUGIN_ROOT" "$PLUGIN_ROOT" "$COPILOT_PLUGIN_ROOT"; do '
  + '[ -n "$d" ] && [ -f "$d/tools/setup.mjs" ] && exec node "$d/tools/setup.mjs" hook; done; '
  + 's="${CARTWRIGHT_STATE_DIR:-$HOME/.cartwright}/plugin-root"; '
  + '[ -f "$s" ] && d=$(cat "$s") && [ -f "$d/tools/setup.mjs" ] && exec node "$d/tools/setup.mjs" hook; exit 0';
// The guardrail hook, before every write-capable tool call (decision record 0012). Its command, matcher and timeout
// are fixed from phase 1 on: Codex trusts a hook by a hash of its entry, so any change here, or a new group inserted
// before it, asks every Codex user to approve the hooks again. New hooks are appended after it; logic changes go in
// tools/guard.mjs. No find here: it would be too slow on every tool call.
const GUARD = 'command -v node >/dev/null 2>&1 || exit 0; '
  + 'for d in "$CLAUDE_PLUGIN_ROOT" "$COPILOT_PLUGIN_ROOT" "$PLUGIN_ROOT"; do '
  + '[ -n "$d" ] && [ -f "$d/tools/guard.mjs" ] && exec node "$d/tools/guard.mjs" pre-tool-use; done; '
  + 's="${CARTWRIGHT_STATE_DIR:-$HOME/.cartwright}/plugin-root"; '
  + '[ -f "$s" ] && d=$(cat "$s") && [ -f "$d/tools/guard.mjs" ] && exec node "$d/tools/guard.mjs" pre-tool-use; exit 0';
// Every command-capable or write-capable tool the agents ship, whether or not the guard reads it yet (decision record
// 0012; sources in guard.mjs): Claude Code's and their lowercase forms; Copilot CLI 1.0.96's; Codex 0.162.1's (write_stdin
// types into a running shell); VS Code 1.141's. VS Code doesn't apply matchers (its loader reads only each group's
// hooks), so there the guard sees every tool; its names are listed for the day it does.
const GUARD_MATCHER = [
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Create',
  'bash', 'shell', 'edit', 'write', 'multiedit', 'notebookedit',
  'powershell', 'PowerShell', 'local_shell', 'write_bash', 'write_powershell', 'create', 'str_replace', 'str_replace_editor', 'apply_patch',
  'exec_command', 'write_stdin', 'shell_command',
  'run_in_terminal', 'send_to_terminal', 'create_and_run_task', 'run_task', 'run_vscode_command', 'run_notebook_cell', 'create_file',
  'replace_string_in_file', 'multi_replace_string_in_file', 'insert_edit_into_file', 'edit_notebook_file', 'create_directory', 'edit_files',
].join('|');
out.set('plugin/hooks/hooks.json', JSON.stringify({
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `sh -c '${HOOK}'`, timeout: 10 }] }],
    PreToolUse: [{ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: `sh -c '${GUARD}'`, timeout: 30 }] }],
  },
}, null, 2) + '\n');

// GitHub Copilot (CLI and VS Code) reads the plugin.json at the plugin root. It must be in Copilot's own
// format (no $schema) and declare its parts: in the Agent Plugins 1.0 format Copilot loads no hooks, so the
// session-start hook never ran. Declared like this, Copilot runs the same hooks/hooks.json as Claude Code.
out.set('plugin/plugin.json', JSON.stringify({
  name: 'cartwright', version: pkg.version, description: pkg.description, author: { name: pkg.author },
  repository: 'https://github.com/shriramjanakiraman/cartwright',
  keywords: ['skills', 'agents', 'project-profile', 'guardrails', 'claude-code', 'codex', 'copilot', 'salesforce', 'b2c-commerce', 'commerce-cloud', 'sfra', 'storefront-next'],
  skills: './skills/',
  hooks: './hooks/hooks.json',
  ...(Object.keys(servers).length ? { mcpServers: './mcp.json' } : {}),
}, null, 2) + '\n');
if (Object.keys(servers).length) out.set('plugin/mcp.json', JSON.stringify({ mcpServers: servers }, null, 2) + '\n');

// Codex reads its own manifests but the same skills/ folder and .mcp.json. The version is what makes
// Codex notice an update, so it follows package.json like the Claude Code plugin does.
out.set('.agents/plugins/marketplace.json', JSON.stringify({
  name: 'cartwright',
  interface: { displayName: 'Cartwright' },
  plugins: [{
    name: 'cartwright', description: pkg.description,
    source: { source: 'local', path: './plugin' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }],
}, null, 2) + '\n');
out.set('plugin/.codex-plugin/plugin.json', JSON.stringify({
  name: 'cartwright', version: pkg.version, description: pkg.description, author: { name: pkg.author },
  keywords: ['skills', 'agents', 'project-profile', 'guardrails', 'claude-code', 'codex', 'copilot', 'salesforce', 'b2c-commerce', 'commerce-cloud', 'sfra', 'storefront-next'],
  skills: './skills/',
  ...(Object.keys(servers).length ? { mcpServers: './.mcp.json' } : {}),
  interface: {
    displayName: 'Cartwright',
    shortDescription: 'A profile and guardrails for any project, our shared skills, and every official Salesforce B2C skill.',
    longDescription: pkg.description,
    developerName: pkg.author,
    category: 'Developer Tools',
    capabilities: ['Read', 'Write'],
    defaultPrompt: [
      'Set up this project',
      'Why was that blocked?',
      'Make what we just did into a skill',
    ],
  },
}, null, 2) + '\n');

for (const s of shipped) out.set(`plugin/skills/${s.data.name}/SKILL.md`, s.text);

const walk = (dir, base = dir, acc = []) => {
  for (const f of readdirSync(dir)) { const p = join(dir, f); statSync(p).isDirectory() ? walk(p, base, acc) : acc.push(relative(base, p)); }
  return acc;
};
for (const o of official) for (const f of walk(o.dir)) out.set(`plugin/skills/${o.name}/${f}`, readFileSync(join(o.dir, f)));

const licensed = [...new Set(official.map((o) => o.source))];
for (const source of licensed) {
  for (const f of readdirSync(join(UPSTREAM_DIR, source))) {
    if (/^(licen[cs]e|notice)(\.(txt|md))?$/i.test(f)) out.set(`plugin/licenses/${source}-${f}`, readFileSync(join(UPSTREAM_DIR, source, f)));
  }
}

// INDEX.md
const row = (s) => `| \`${s.data.name}\` | ${s.data.status} | ${asList(s.data['applies-to']).join(', ')} | ${String(s.data.description).replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`;
const ourTable = skills.length
  ? ['| Skill | Status | Applies to | Description |', '|---|---|---|---|', ...skills.map(row)].join('\n')
  : '_No skills yet._';
const bySet = {};
for (const o of official) (bySet[`${o.source} / ${o.set}`] ||= []).push(o.name);
const officialTable = Object.keys(bySet).length
  ? ['| Source / set | Skills |', '|---|---|', ...Object.entries(bySet).map(([k, v]) => `| \`${k}\` | ${v.map((n) => `\`${n}\``).join(', ')} |`)].join('\n')
  : '_None mirrored yet. Run `npm run sync-upstream`._';
const pins = Object.entries(lock.sources).map(([id, s]) =>
  `| \`${id}\` | ${s.version || s.sha?.slice(0, 7) || '—'} | ${s.mirror ? 'bundled skills' : s.mcpServer ? 'bundled MCP server' : 'referenced'} | ${s.note || (s.usedBy ? `used by ${asList(s.usedBy).map((u) => `\`${u}\``).join(', ')}` : '')} |`);

out.set('INDEX.md', `# Skill index

> Generated by \`scripts/build.mjs\`. Do not edit by hand.

Version **${pkg.version}**. One install delivers **${shipped.length + official.length} skills**: ${shipped.length} of ours and ${official.length} official${servers['b2c-dx-mcp'] ? ', plus the B2C MCP server' : ''}.

## Our skills (\`core/\`)

${ourTable}

## Official skills (bundled from \`upstream/\`, read-only)

Mirrored unmodified at the versions pinned below. Licences are in \`plugin/licenses/\`. Updated only through Door A.

${officialTable}

## Pinned sources

| Source | Pinned at | Delivered as | Notes |
|---|---|---|---|
${pins.join('\n')}
`);

const same = (p, c) => existsSync(p) && Buffer.compare(readFileSync(p), Buffer.from(c)) === 0;
if (check) {
  const stale = [...out].filter(([rel, c]) => !same(join(ROOT, rel), c)).map(([rel]) => rel);
  const pdir = join(ROOT, 'plugin');
  if (existsSync(pdir)) for (const f of walk(pdir)) if (!out.has(`plugin/${f}`)) stale.push(`plugin/${f} (no longer shipped)`);
  if (stale.length) {
    console.error(`build --check: generated output is stale (${stale.length} file(s)). Run "npm run build" and commit, e.g.\n  ${stale.slice(0, 10).join('\n  ')}`);
    process.exit(1);
  }
  console.log('build --check: generated output is current');
} else {
  rmSync(join(ROOT, 'plugin'), { recursive: true, force: true });
  for (const [rel, c] of out) { const p = join(ROOT, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); }
  console.log(`build: ${shipped.length} core + ${official.length} official skill(s)${Object.keys(servers).length ? ` + MCP (${Object.keys(servers).join(', ')})` : ''} → plugin/, INDEX.md`);
}
