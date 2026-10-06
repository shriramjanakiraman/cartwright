#!/usr/bin/env node
// Builds a project overlay repo into its own private Claude Code plugin, the same way build.mjs builds core:
//   <overlay>/plugin/skills/<name>/SKILL.md            active project skills
//   <overlay>/.claude-plugin/marketplace.json          so the overlay repo installs as a plugin marketplace
//   <overlay>/plugin/.codex-plugin/plugin.json         the same plugin for Codex
//   <overlay>/.agents/plugins/marketplace.json         so the overlay repo installs as a Codex marketplace
//   <overlay>/INDEX.md                                 the overlay's catalogue
//   <overlay>/plugin/plugin.json                       the Agent Plugins 1.0 manifest (GitHub Copilot, VS Code)
//   <overlay>/client-project/                          the kit a lead commits once into the client project's repo,
//                                                      so everyone who opens that project gets core + this overlay
//                                                      in Claude Code, Codex, Copilot CLI and VS Code
// Run from the core repo:
//   node scripts/build-overlay.mjs ../<overlay-repo>           # write
//   node scripts/build-overlay.mjs ../<overlay-repo> --check   # CI: fail if stale
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { loadOverlay, asList } from './lib.mjs';

const dirArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const check = process.argv.includes('--check');
const ov = dirArg && loadOverlay(resolve(dirArg));
if (!ov) { console.error('build-overlay: pass the path of an overlay repo (a folder containing overlay.json)'); process.exit(2); }

const { project, version = '0.1.0', owner = 'engagement team', repo, coreRepo = 'shriramjanakiraman/agent-skills' } = ov.config;
const marketplace = `${project}-agent-skills`;
const plugin = `${project}-skills`;
const shipped = ov.skills.filter((s) => s.data?.status === 'active');
const out = new Map();

out.set('.claude-plugin/marketplace.json', JSON.stringify({
  name: marketplace,
  owner: { name: owner },
  plugins: [{ name: plugin, description: `Project ${project} only: client-specific skills for this engagement.`, version, source: './plugin' }],
}, null, 2) + '\n');
out.set('plugin/.claude-plugin/plugin.json', JSON.stringify({
  name: plugin, version, description: `Project ${project} only: client-specific skills for this engagement.`, author: { name: owner },
}, null, 2) + '\n');
for (const s of shipped) out.set(`plugin/skills/${s.data.name}/SKILL.md`, s.text);

// Codex: its own manifests over the same skills/ folder. The version (from overlay.json) is what makes
// Codex notice an update.
const desc = `Project ${project} only: client-specific skills for this engagement.`;
out.set('.agents/plugins/marketplace.json', JSON.stringify({
  name: marketplace,
  interface: { displayName: `${project} agent skills` },
  plugins: [{ name: plugin, description: desc, source: { source: 'local', path: './plugin' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' }],
}, null, 2) + '\n');
out.set('plugin/.codex-plugin/plugin.json', JSON.stringify({
  name: plugin, version, description: desc, author: { name: owner }, skills: './skills/',
  interface: { displayName: `${project} skills`, shortDescription: desc, developerName: owner, category: 'Developer Tools', capabilities: ['Read'] },
}, null, 2) + '\n');

out.set('plugin/plugin.json', JSON.stringify({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: plugin, version, description: desc, author: { name: owner },
}, null, 2) + '\n');

// The client project kit. A lead copies client-project/ into the client project's repo root once (merging
// with any files already there). Anyone who opens that project is then offered, or given, the core plugin
// and this overlay's plugin, with no setup of their own. It holds no client skills, only pointers; GitHub
// access to the private overlay repo decides who can actually download it.
const overlayRepo = repo || `<owner>/${marketplace}`;
const settings = JSON.stringify({   // Claude Code (.claude/) and GitHub Copilot CLI + VS Code (.github/copilot/)
  extraKnownMarketplaces: {
    'agent-skills': { source: { source: 'github', repo: coreRepo } },
    [marketplace]: { source: { source: 'github', repo: overlayRepo } },
  },
  enabledPlugins: { 'agent-skills@agent-skills': true, [`${plugin}@${marketplace}`]: true },
}, null, 2) + '\n';
out.set('client-project/.claude/settings.json', settings);
out.set('client-project/.github/copilot/settings.json', settings);
// Codex: a repo marketplace listing both plugins straight from their GitHub repos, and a project config
// that enables them. Codex installs and refreshes enabled plugins when it refreshes marketplaces.
const codexMarket = `${project}-project`;
const gitPlugin = (name, gh, description) => ({ name, description,
  source: { source: 'git-subdir', url: `https://github.com/${gh}.git`, path: './plugin', ref: 'main' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' });
out.set('client-project/.agents/plugins/marketplace.json', JSON.stringify({
  name: codexMarket,
  interface: { displayName: `${project} project skills` },
  plugins: [
    gitPlugin('agent-skills', coreRepo, 'Shared skills: ours plus every official Salesforce B2C skill and the B2C MCP server.'),
    gitPlugin(plugin, overlayRepo, desc),
  ],
}, null, 2) + '\n');
out.set('client-project/.codex/config.toml', `# Enables this project's skills in Codex (see .agents/plugins/marketplace.json). Generated by the
# agent-skills core repo's build-overlay.mjs for project ${project}.
[plugins."agent-skills@${codexMarket}"]
enabled = true

[plugins."${plugin}@${codexMarket}"]
enabled = true
`);
out.set('client-project/README.md', `# Agent skills for project ${project}

Copy everything in this folder (hidden folders included) into the root of the **client project's** repo,
and commit it once. If a file already exists there, merge the entries instead of replacing it.

| File | Agent | What it does |
|---|---|---|
| \`.claude/settings.json\` | Claude Code (VS Code also reads it) | offers the core and ${project} plugins, enabled for this project |
| \`.github/copilot/settings.json\` | GitHub Copilot CLI and VS Code | declares the same two plugins |
| \`.agents/plugins/marketplace.json\` | Codex | lists both plugins from their GitHub repos |
| \`.codex/config.toml\` | Codex | enables both for this project |

Anyone who opens the project then gets the shared skills plus ${project}'s skills, with no setup of their own.
Only people whose GitHub account can read \`${overlayRepo}\` can download the ${project} skills.

Don't copy this README; it's only instructions. Regenerated by \`build-overlay.mjs\`; don't edit these files
by hand in the overlay repo.
`);

const row = (s) => `| \`${s.data.name}\` | ${s.data.status} | ${String(s.data.description).replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`;
out.set('INDEX.md', `# ${project} overlay skills

> Generated by the core repo's \`scripts/build-overlay.mjs\`. Do not edit by hand.

Version **${version}** · ${shipped.length} active project skill(s) in plugin \`${plugin}@${marketplace}\`.

${ov.skills.length ? ['| Skill | Status | Description |', '|---|---|---|', ...ov.skills.filter((s) => s.data).map(row)].join('\n') : '_No skills yet._'}
`);

const walk = (d, base = d, acc = []) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, base, acc) : acc.push(relative(base, p)); } return acc; };
if (check) {
  const stale = [...out].filter(([rel, c]) => { const p = join(ov.dir, rel); return !existsSync(p) || readFileSync(p, 'utf8') !== c; }).map(([r]) => r);
  for (const d of ['plugin', 'client-project']) {
    const dir = join(ov.dir, d);
    if (existsSync(dir)) for (const f of walk(dir)) if (!out.has(`${d}/${f}`)) stale.push(`${d}/${f} (no longer generated)`);
  }
  if (existsSync(join(ov.dir, 'client-project-settings.json'))) stale.push('client-project-settings.json (replaced by client-project/)');
  if (stale.length) { console.error(`build-overlay --check: stale output, run build-overlay and commit:\n  ${stale.join('\n  ')}`); process.exit(1); }
  console.log(`build-overlay --check (${project}): generated output is current`);
} else {
  for (const d of ['plugin', 'client-project', 'client-project-settings.json']) rmSync(join(ov.dir, d), { recursive: true, force: true });
  for (const [rel, c] of out) { const p = join(ov.dir, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, c); }
  console.log(`build-overlay (${project}): ${shipped.length} skill(s) → plugin ${plugin}@${marketplace}`);
}
