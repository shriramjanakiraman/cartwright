// The client project kit: the few files a client project's repo carries so that everyone who opens it gets
// the core plugin plus that client's overlay plugin, in Claude Code, Codex, GitHub Copilot CLI and VS Code.
// They hold no client skills, only pointers to the two repos; git access to the overlay decides who can
// download it. Works with any git host (GitHub, GitLab, Bitbucket, self-hosted).
//
// Used by build-overlay.mjs (to generate client-project/ in an overlay repo) and by setup.mjs (shipped in
// the plugin, to add the kit to a client project during setup). No dependencies: plain Node 20+.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CORE_REPO = 'shriramjanakiraman/cartwright';

// "owner/repo", or a GitHub URL, as owner/repo; null for any other host.
export function githubRepo(ref) {
  if (/^[\w.-]+\/[\w.-]+$/.test(ref)) return ref.replace(/\.git$/, '');
  const m = String(ref).match(/^(?:https:\/\/|git@)github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}
// A clonable git URL for any reference.
export const gitUrl = (ref) => (githubRepo(ref) && !/^(https?:|git@|ssh:)/.test(ref) ? `https://github.com/${githubRepo(ref)}.git` : ref);
// Marketplace source for Claude Code and Copilot settings files.
const settingsSource = (ref) => (githubRepo(ref) ? { source: 'github', repo: githubRepo(ref) } : { source: 'git', url: ref });

export const names = (code) => ({ marketplace: `${code}-cartwright`, plugin: `${code}-skills`, codexMarketplace: `${code}-project` });

// The kit for project `code` whose overlay lives at `overlay` (owner/repo or any git URL).
export function kitFiles({ code, overlay, core = CORE_REPO, lead }) {
  const { marketplace, plugin, codexMarketplace } = names(code);
  const settings = JSON.stringify({
    extraKnownMarketplaces: { 'cartwright': { source: settingsSource(core) }, [marketplace]: { source: settingsSource(overlay) } },
    enabledPlugins: { 'cartwright@cartwright': true, [`${plugin}@${marketplace}`]: true },
  }, null, 2) + '\n';
  const gitPlugin = (name, ref, description) => ({ name, description,
    source: { source: 'git-subdir', url: gitUrl(ref), path: './plugin', ref: 'main' },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Developer Tools' });
  return new Map([
    ['.claude/settings.json', settings],
    ['.github/copilot/settings.json', settings],
    ['.agents/plugins/marketplace.json', JSON.stringify({
      name: codexMarketplace,
      interface: { displayName: `${code} project skills` },
      plugins: [
        gitPlugin('cartwright', core, 'Shared skills: ours plus every official Salesforce B2C skill and the B2C MCP server.'),
        gitPlugin(plugin, overlay, `Project ${code} only: client-specific skills for this engagement.`),
      ],
    }, null, 2) + '\n'],
    ['.codex/config.toml', codexToml(codexMarketplace, plugin)],
    ['AGENT-SKILLS.md', readme({ code, overlay, lead })],
  ]);
}

const codexToml = (market, plugin) => `# Enables this project's skills in Codex (see .agents/plugins/marketplace.json).
[plugins."cartwright@${market}"]
enabled = true

[plugins."${plugin}@${market}"]
enabled = true
`;

const readme = ({ code, overlay, lead }) => `# Agent skills for this project

This project is set up for Cartwright (the shared agent skills library) plus the **${code}** project skills. Anyone who
opens it in Claude Code, Codex, GitHub Copilot CLI or VS Code gets both, with no setup of their own.

| File | Agent |
|---|---|
| \`.claude/settings.json\` | Claude Code (VS Code also reads it) |
| \`.github/copilot/settings.json\` | GitHub Copilot CLI and VS Code |
| \`.agents/plugins/marketplace.json\`, \`.codex/config.toml\` | Codex |

The ${code} skills come from \`${overlay}\`; only accounts that can read that repo can download them.${lead ? ` For access, ask ${lead}.` : ''}
VS Code may not pick up workspace plugins yet (microsoft/vscode#327404); if so, run *Chat: Install Plugin From
Source* once with the core repo and then the ${code} repo.
`;

// Add the kit to a project, merging with files that already exist. Returns changed paths, with a notes array.
export function applyKit(dir, opts) {
  const files = kitFiles(opts);
  const changed = [];
  Object.defineProperty(changed, 'notes', { value: [] });
  const readJson = (rel) => {
    const p = join(dir, rel);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); }
    catch { throw new Error(`${p} could not be read as valid JSON; fix or remove it before adding the kit`); }
  };
  // Validate all existing JSON before writing any part of the kit.
  const existing = new Map(['.claude/settings.json', '.github/copilot/settings.json', '.agents/plugins/marketplace.json']
    .map((rel) => [rel, readJson(rel)]));
  const write = (rel, text) => {
    const p = join(dir, rel);
    if (existsSync(p) && readFileSync(p, 'utf8') === text) return;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    changed.push(rel);
  };
  for (const rel of ['.claude/settings.json', '.github/copilot/settings.json']) {
    const want = JSON.parse(files.get(rel));
    const have = existing.get(rel) || {};
    have.extraKnownMarketplaces = { ...(have.extraKnownMarketplaces || {}), ...want.extraKnownMarketplaces };
    have.enabledPlugins = { ...(have.enabledPlugins || {}), ...want.enabledPlugins };
    write(rel, JSON.stringify(have, null, 2) + '\n');
  }

  // Codex: keep an existing repo marketplace (and its name), adding or replacing our two plugins in it.
  const want = JSON.parse(files.get('.agents/plugins/marketplace.json'));
  const have = existing.get('.agents/plugins/marketplace.json');
  const market = have?.name || want.name;
  const merged = have ? { ...have, plugins: [...(have.plugins || []).filter((p) => !want.plugins.some((w) => w.name === p.name)), ...want.plugins] } : want;
  write('.agents/plugins/marketplace.json', JSON.stringify(merged, null, 2) + '\n');
  const tomlPath = join(dir, '.codex/config.toml');
  let toml = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  if (!toml.trim()) toml = codexToml(market, names(opts.code).plugin);
  else for (const p of want.plugins) {
    const header = `[plugins."${p.name}@${market}"]`;
    if (!toml.includes(header)) toml = `${toml.replace(/\n*$/, '\n\n')}${header}\nenabled = true\n`;
    else {
      const lines = toml.split(/\r?\n/);
      const start = lines.findIndex((line) => line.trim().startsWith(header) && /^\s*(?:#.*)?$/.test(line.trim().slice(header.length)));
      const end = lines.findIndex((line, i) => i > start && /^\s*\[/.test(line));
      if (start >= 0 && lines.slice(start + 1, end < 0 ? undefined : end).some((line) => /^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(line))) {
        changed.notes.push(`${p.name} is switched off in .codex/config.toml; set enabled = true to use it`);
      }
    }
  }
  write('.codex/config.toml', toml);
  write('AGENT-SKILLS.md', files.get('AGENT-SKILLS.md'));
  return changed;
}

// Which project, if any, a directory's kit points at: { code, overlay } or null.
export function readKit(dir) {
  for (const rel of ['.claude/settings.json', '.github/copilot/settings.json']) {
    try {
      const s = JSON.parse(readFileSync(join(dir, rel), 'utf8'));
      for (const key of Object.keys(s.enabledPlugins || {})) {
        const m = key.match(/^([a-z][a-z0-9]{1,15})-skills@\1-cartwright$/);
        if (m) { const src = s.extraKnownMarketplaces?.[`${m[1]}-cartwright`]?.source || {}; return { code: m[1], overlay: src.repo || src.url || null }; }
      }
    } catch { /* not there */ }
  }
  return null;
}
