#!/usr/bin/env node
// End-to-end test of what a developer gets from the plugin, on a simulated bare machine: a throwaway home
// folder and a PATH with only node, npx and git (uv is added for the steps that need it). Nothing on the
// real machine is read or changed apart from network fetches. Each step is checked and reported; a failed
// step doesn't stop the rest.
//
// Usage: node scripts/e2e.mjs [options]
//   --ref <branch|tag>     plugin to test, fetched from GitHub like a plugin manager would (default: main)
//   --plugin <dir>         test a local plugin folder instead (e.g. ./plugin after npm run build)
//   --registry <file>      registry for the tested plugin (default: tests/fixtures/registry.json, which holds
//                          the made-up test client; --no-fixture-registry keeps the plugin's own)
//   --client <owner/repo>  client project to set up (default: from tests/fixtures.json)
//   --alias <name>         a registered name of that client to look up (default: from tests/fixtures.json)
//   --unknown <name>       a name that must NOT be found (default: from tests/fixtures.json)
//   --fast                 skip the steps that download tools (B2C CLI run, --smoke): for quick checks
//   --pr                   also push the kit to a branch of the client repo and open a draft pull request
//                          (closed and the branch deleted afterwards unless --keep)
//   --keep                 keep the work folder (and the pull request) for inspection
// Needs git credentials that can read the core, overlay and client repos (and push, with --pr).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const FX = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures.json'), 'utf8'));
const CORE = FX.core;
const CLIENT = opt('--client', FX.client);
const ALIAS = opt('--alias', FX.alias);
const UNKNOWN = opt('--unknown', FX.unknown);
const REGISTRY = args.includes('--no-fixture-registry') ? null : opt('--registry', join(ROOT, FX.registry));
const FAST = args.includes('--fast');
// Real path for the work folder (macOS's tmpdir is behind a symlink); symlinked starts are tested on purpose below.
const WORK = mkdtempSync(join(realpathSync(tmpdir()), 'cartwright-e2e-'));
const HOME = join(WORK, 'home');
mkdirSync(HOME);

// A bare PATH: just the runtimes a developer must have. uv is a separate PATH for the steps that need it.
const which = (c) => { const r = spawnSync('/usr/bin/which', [c], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const binDir = (name, cmds) => { const d = join(WORK, name); mkdirSync(d); for (const c of cmds) if (which(c)) symlinkSync(which(c), join(d, c)); return d; };
const BARE = `${binDir('bin-bare', ['node', 'npx', 'npm', 'git', 'gh'])}:/usr/bin:/bin`;
const WITH_UV = `${binDir('bin-uv', ['uv', 'uvx'])}:${BARE}`;
// The throwaway home has no git or gh sign-in, so with GH_TOKEN set, git gets it straight from the
// environment (the same way CI would); otherwise the machine's own git credentials apply.
const gitAuth = process.env.GH_TOKEN ? { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' } : {};
const env = (path, extra = {}) => ({ ...process.env, ...gitAuth, HOME, PATH: path, NO_COLOR: '1', ...extra });
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 600000, ...o });

const results = [];
function step(name, fn) {
  try { const detail = fn(); results.push({ name, ok: true, detail: detail || '' }); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message || e).split('\n').slice(0, 3).join(' ') }); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const json = (r) => { assert(r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`); return JSON.parse(r.stdout); };

// --- the plugin under test ----------------------------------------------------------------------------
let PLUGIN, coreDir;
step(`get the plugin (${opt('--plugin') ? opt('--plugin') : `${CORE}@${opt('--ref', 'main')}`})`, () => {
  if (opt('--plugin')) { PLUGIN = join(WORK, 'plugin'); cpSync(resolve(opt('--plugin')), PLUGIN, { recursive: true }); coreDir = ROOT; }
  else {
    coreDir = join(WORK, 'core');
    const r = sh('git', ['clone', '-q', '--depth', '1', '--branch', opt('--ref', 'main'), `https://github.com/${CORE}.git`, coreDir], { env: env(BARE) });
    assert(r.status === 0, `clone failed: ${r.stderr.trim()}`);
    PLUGIN = join(coreDir, 'plugin');
  }
  if (REGISTRY) cpSync(resolve(REGISTRY), join(PLUGIN, 'tools', 'registry.json'));
  const v = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  return `${v.name} ${v.version}${REGISTRY ? ', test registry' : ''}`;
});
const RUN = () => join(PLUGIN, 'tools', 'run.mjs');
const SETUP = () => join(PLUGIN, 'tools', 'setup.mjs');
const node = (script, a, path = BARE, o = {}) => sh(join(BARE.split(':')[0], 'node'), [script, ...a], { env: env(path), ...o });
const hook = (cwd, path = BARE) => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
  return sh('/bin/sh', ['-c', cmd], { cwd, env: env(path, { CLAUDE_PLUGIN_ROOT: PLUGIN }) }).stdout;
};

step('plugin and marketplace pass Claude Code\'s validator', () => {
  const claude = process.env.CLAUDE_BIN || which('claude');
  if (!claude) return 'skipped: no claude binary (set CLAUDE_BIN)';
  const out = [];
  for (const p of [opt('--plugin') ? null : coreDir, PLUGIN].filter(Boolean)) {
    const r = sh(claude, ['plugin', 'validate', p], { env: { ...process.env } });
    assert(r.status === 0, `${p}: ${(r.stdout + r.stderr).trim().slice(0, 300)}`);
    out.push(p === PLUGIN ? 'plugin' : 'marketplace');
  }
  return out.join(' + ') + ' valid';
});

step('every agent manifest names the same plugin and version', () => {
  const read = (f) => JSON.parse(readFileSync(join(PLUGIN, f), 'utf8'));
  const c = read('.claude-plugin/plugin.json'), x = read('.codex-plugin/plugin.json'), a = read('plugin.json');
  assert(c.name === x.name && x.name === a.name, `names differ: ${c.name} / ${x.name} / ${a.name}`);
  assert(c.version === x.version && x.version === a.version, `versions differ: ${c.version} / ${x.version} / ${a.version}`);
  assert(existsSync(join(PLUGIN, x.skills || './skills/')), 'Codex skills folder missing');
  return `${c.name} ${c.version} (Claude Code, Codex, Copilot)`;
});

step('the Copilot manifest declares the hooks and skills (else Copilot runs no session-start hook)', () => {
  const a = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));
  assert(!a.$schema, 'plugin.json is in Agent Plugins 1.0 form ($schema): Copilot loads no hooks from it');
  assert(a.hooks && existsSync(join(PLUGIN, a.hooks)), `hooks ${a.hooks ? `"${a.hooks}" not found` : 'not declared'}`);
  assert(JSON.parse(readFileSync(join(PLUGIN, a.hooks), 'utf8')).hooks?.SessionStart, `${a.hooks} has no SessionStart hook`);
  assert(a.skills && existsSync(join(PLUGIN, a.skills, 'client-setup', 'SKILL.md')), `skills ${a.skills ? `"${a.skills}" isn't the skills folder` : 'not declared'}`);
  assert(!a.mcpServers || existsSync(join(PLUGIN, a.mcpServers)), `mcpServers "${a.mcpServers}" not found`);
  return `hooks ${a.hooks}, skills ${a.skills}${a.mcpServers ? `, MCP ${a.mcpServers}` : ''}`;
});

// --- tools without installing -------------------------------------------------------------------------
const pins = () => JSON.parse(readFileSync(join(PLUGIN, 'tools', 'versions.json'), 'utf8'));
const empty = join(WORK, 'empty'); mkdirSync(empty);

step('session start outside a project: names the missing tools, no setup offer', () => {
  const out = hook(empty);
  assert(/Not installed on this machine: b2c, specify, graphify/.test(out), `got: ${out.slice(0, 200) || '(nothing)'}`);
  assert(!/isn't set up/.test(out), 'offered client setup outside a git repo');
  return 'tools note shown';
});

step('--check without uv: B2C CLI on demand, spec-kit and graphify need uv', () => {
  const r = json(node(RUN(), ['--check', '--json'], BARE));
  const by = Object.fromEntries(r.tools.map((t) => [t.tool, t]));
  assert(by.b2c.route === 'npx', `b2c route ${by.b2c.route}`);
  assert(by.specify.route === 'unavailable' && by.graphify.route === 'unavailable', 'spec-kit/graphify should need uvx');
  assert(/uv/.test(by.graphify.fix || ''), 'no uv install hint');
  return `b2c via npx; specify/graphify: "${by.graphify.fix}"`;
});

step('the helper works when started through a symlinked path', () => {
  const link = join(WORK, 'plugin-link');
  symlinkSync(PLUGIN, link);
  const r = node(join(link, 'tools', 'run.mjs'), ['--check', '--json'], BARE);
  assert(r.stdout.trim(), 'no output: the helper did nothing when started through a symlink');
  return `${JSON.parse(r.stdout).tools.length} tools reported`;
});

if (!FAST) step('B2C CLI runs without installing, at the pinned version', () => {
  const r = node(RUN(), ['b2c', '--version'], BARE);
  assert(r.status === 0, `exit ${r.status}: ${r.stderr.trim().slice(-300)}`);
  assert(r.stdout.includes(pins()['b2c-cli']), `expected ${pins()['b2c-cli']}, got ${r.stdout.trim()}`);
  return r.stdout.trim().split('\n')[0];
});

if (!FAST) step('with uv: every pinned tool runs and reports its version (--smoke)', () => {
  const r = node(RUN(), ['--smoke'], WITH_UV);
  const rows = JSON.parse(r.stdout);
  const bad = rows.filter((x) => !x.ok);
  assert(!bad.length, bad.map((x) => `${x.label}: ${x.detail}`).join('; '));
  return rows.map((x) => `${x.label} ${x.pinned}`).join(', ');
});

// --- client setup -------------------------------------------------------------------------------------
const clientDir = join(WORK, 'client');
step(`clone the client project (${CLIENT})`, () => {
  const r = sh('git', ['clone', '-q', `https://github.com/${CLIENT}.git`, clientDir], { env: env(BARE) });
  assert(r.status === 0, `clone failed: ${r.stderr.trim()}`);
  return 'cloned';
});

step('session start in the client project: offers client setup once', () => {
  const out = hook(clientDir);
  assert(/isn't set up for client project skills/.test(out), `no setup offer; got: ${out.slice(0, 200) || '(nothing)'}`);
  assert(/set up, not now, or no client/.test(out), 'answers missing from the offer');
  return 'offer shown';
});

step(`lookup "${UNKNOWN}" finds nothing`, () => {
  const r = json(node(SETUP(), ['lookup', UNKNOWN]));
  assert(r.matches.length === 0, `unexpected matches: ${JSON.stringify(r.matches)}`);
  return 'no match';
});

let found;
step(`lookup "${ALIAS}" finds the client`, () => {
  const r = json(node(SETUP(), ['lookup', ALIAS]));
  assert(r.matches.length >= 1, 'no match (is the client registered in this plugin\'s registry?)');
  found = r.matches[0];
  return `${found.client} (${found.code}, ${found.match}), lead ${found.lead}, overlay ${found.overlay}`;
});

step('this machine can read the overlay and the core repo', () => {
  assert(found, 'skipped: no client found');
  const a = json(node(SETUP(), ['access', found.overlay]));
  const c = json(node(SETUP(), ['access', CORE]));
  assert(a.canRead, `overlay: ${a.reason}`);
  assert(c.canRead, `core: ${c.reason}`);
  return 'both readable';
});

step('the kit is added, recognised, and adding it again changes nothing', () => {
  assert(found, 'skipped: no client found');
  const a = json(node(SETUP(), ['kit', '--code', found.code, '--overlay', found.overlay, '--lead', found.lead], BARE, { cwd: clientDir }));
  assert(a.changed.length === 5, `expected 5 files, got ${a.changed.join(', ')}`);
  const b = json(node(SETUP(), ['kit', '--code', found.code, '--overlay', found.overlay, '--lead', found.lead], BARE, { cwd: clientDir }));
  assert(b.changed.length === 0, `second run changed ${b.changed.join(', ')}`);
  const s = json(node(SETUP(), ['status'], BARE, { cwd: clientDir }));
  assert(s.kit?.code === found.code, `status kit: ${JSON.stringify(s.kit)}`);
  return a.changed.join(', ');
});

step('session start after the kit: no setup offer', () => {
  assert(found, 'skipped: no client found');
  const out = hook(clientDir);
  assert(!/isn't set up/.test(out), 'still offering setup');
  return out.trim() ? 'only the tools note' : 'silent';
});

// Every plugin source the kit points at must actually resolve to the right plugin.
const fetched = new Map();
function fetchRepo(url, ref = 'main') {
  if (fetched.has(url)) return fetched.get(url);
  const d = join(WORK, 'sources', String(fetched.size));
  const r = sh('git', ['clone', '-q', '--depth', '1', '--branch', ref, url, d], { env: env(BARE) });
  assert(r.status === 0, `can't fetch ${url}: ${r.stderr.trim()}`);
  fetched.set(url, d);
  return d;
}
const ghUrl = (src) => (src.source === 'github' ? `https://github.com/${src.repo}.git` : src.url);

step('Claude Code / Copilot settings: each marketplace resolves and offers the enabled plugin', () => {
  assert(found, 'skipped: no client found');
  const out = [];
  for (const f of ['.claude/settings.json', '.github/copilot/settings.json']) {
    const s = JSON.parse(readFileSync(join(clientDir, f), 'utf8'));
    for (const key of Object.keys(s.enabledPlugins)) {
      const [plugin, market] = key.split('@');
      const src = s.extraKnownMarketplaces[market]?.source;
      assert(src, `${f}: no marketplace "${market}"`);
      const m = JSON.parse(readFileSync(join(fetchRepo(ghUrl(src)), '.claude-plugin', 'marketplace.json'), 'utf8'));
      assert(m.name === market, `${f}: marketplace at ${ghUrl(src)} is named ${m.name}, not ${market}`);
      assert(m.plugins.some((p) => p.name === plugin), `${f}: ${market} has no plugin ${plugin}`);
      out.push(key);
    }
  }
  return [...new Set(out)].join(', ');
});

step('Codex marketplace: each git-subdir source holds a Codex plugin of that name', () => {
  assert(found, 'skipped: no client found');
  const m = JSON.parse(readFileSync(join(clientDir, '.agents/plugins/marketplace.json'), 'utf8'));
  const toml = readFileSync(join(clientDir, '.codex/config.toml'), 'utf8');
  for (const p of m.plugins.filter((x) => x.source?.source === 'git-subdir')) {
    const d = fetchRepo(p.source.url, p.source.ref);
    const manifest = JSON.parse(readFileSync(join(d, p.source.path, '.codex-plugin', 'plugin.json'), 'utf8'));
    assert(manifest.name === p.name, `${p.source.url}: Codex plugin is ${manifest.name}, not ${p.name}`);
    assert(toml.includes(`[plugins."${p.name}@${m.name}"]`), `config.toml doesn't enable ${p.name}@${m.name}`);
  }
  return m.plugins.map((p) => `${p.name}@${m.name}`).join(', ');
});

step('"no client" is remembered: the next session doesn\'t ask', () => {
  const other = join(WORK, 'other-project'); mkdirSync(other);
  sh('git', ['init', '-q'], { cwd: other, env: env(BARE) });
  assert(/isn't set up/.test(hook(other)), 'expected an offer before answering');
  json(node(SETUP(), ['remember', 'no-client'], BARE, { cwd: other }));
  assert(!/isn't set up/.test(hook(other)), 'asked again after "no client"');
  return 'asked once, then quiet';
});

let prUrl, prBranch;
if (args.includes('--pr')) {
  step('the kit goes to the client repo as a draft pull request', () => {
    assert(found, 'skipped: no client found');
    prBranch = `chore/cartwright-e2e-${Date.now()}`;
    const g = (...a) => { const r = sh('git', a, { cwd: clientDir, env: env(BARE) }); assert(r.status === 0, `git ${a[0]}: ${r.stderr.trim()}`); return r.stdout; };
    g('switch', '-q', '-c', prBranch);
    g('add', '.claude/settings.json', '.github/copilot/settings.json', '.agents/plugins/marketplace.json', '.codex/config.toml', 'AGENT-SKILLS.md');
    g('-c', 'user.name=cartwright-e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', `Connect this project to Cartwright and the ${found.code} project skills (e2e test)`);
    g('push', '-q', '-u', 'origin', prBranch);
    const r = sh('gh', ['pr', 'create', '-R', CLIENT, '--draft', '--head', prBranch, '--title', 'E2E TEST: Cartwright project kit (auto-closed)', '--body', 'Opened and closed automatically by scripts/e2e.mjs.'], { env: { ...process.env } });
    assert(r.status === 0, `gh pr create: ${r.stderr.trim()}`);
    prUrl = r.stdout.trim();
    return prUrl;
  });
}

// --- report and clean up ------------------------------------------------------------------------------
if (prUrl && !args.includes('--keep')) {
  sh('gh', ['pr', 'close', prUrl, '--delete-branch', '--comment', 'Closed by scripts/e2e.mjs.'], { env: { ...process.env } });
}
console.log(`## Cartwright end-to-end test\n`);
console.log('| | Step | Result |\n|---|---|---|');
for (const r of results) console.log(`| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${args.includes('--keep') ? `; work folder kept: ${WORK}` : ''}`);
if (!args.includes('--keep')) rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
