#!/usr/bin/env node
// Door B distribution. Builds everything a user receives from one install:
//   plugin/skills/<name>/              our active core skills + every mirrored official skill
//   plugin/.mcp.json                   the official B2C MCP server, at the pinned version
//   plugin/licenses/                   each upstream publisher's licence (Apache-2.0 attribution)
//   .claude-plugin/marketplace.json    so the repo installs as a Claude Code plugin marketplace
//   plugin/.codex-plugin/plugin.json   the same plugin for Codex (skills/ and .mcp.json are shared)
//   .agents/plugins/marketplace.json   so the repo installs as a Codex plugin marketplace
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
  name: 'agent-skills',
  owner: { name: pkg.author },
  plugins: [{ name: 'agent-skills', description: pkg.description, version: pkg.version, source: './plugin' }],
}, null, 2) + '\n');

out.set('plugin/.claude-plugin/plugin.json', JSON.stringify({
  name: 'agent-skills', version: pkg.version, description: pkg.description, author: { name: pkg.author },
}, null, 2) + '\n');

// MCP servers the plugin registers, pinned to the versions in the lock.
const servers = {};
for (const src of Object.values(lock.sources)) {
  if (src.mcpServer && src.version) servers[src.mcpServer.name] = { command: 'npx', args: ['-y', `${src.mcpServer.package}@${src.version}`] };
}
if (Object.keys(servers).length) out.set('plugin/.mcp.json', JSON.stringify({ mcpServers: servers }, null, 2) + '\n');

// Codex reads its own manifests but the same skills/ folder and .mcp.json. The version is what makes
// Codex notice an update, so it follows package.json like the Claude Code plugin does.
out.set('.agents/plugins/marketplace.json', JSON.stringify({
  name: 'agent-skills',
  interface: { displayName: 'Agent Skills' },
  plugins: [{
    name: 'agent-skills', description: pkg.description,
    source: { source: 'local', path: './plugin' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Developer Tools',
  }],
}, null, 2) + '\n');
out.set('plugin/.codex-plugin/plugin.json', JSON.stringify({
  name: 'agent-skills', version: pkg.version, description: pkg.description, author: { name: pkg.author },
  keywords: ['salesforce', 'b2c-commerce', 'commerce-cloud', 'sfra', 'storefront-next', 'skills'],
  skills: './skills/',
  ...(Object.keys(servers).length ? { mcpServers: './.mcp.json' } : {}),
  interface: {
    displayName: 'Agent Skills',
    shortDescription: 'Our B2C Commerce skills plus every official Salesforce skill and the B2C MCP server.',
    longDescription: pkg.description,
    developerName: pkg.author,
    category: 'Developer Tools',
    capabilities: ['Read', 'Write'],
    defaultPrompt: [
      'Make what we just did into a skill',
      'Something is broken on the sandbox, check the logs',
      'I need a shopper token for my storefront',
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
