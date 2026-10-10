#!/usr/bin/env node
// Drive real agents (Claude Code, GitHub Copilot CLI) headless through the plugin's main scenarios, and check
// what they actually did: which skills and commands they ran, what they changed, and what they answered.
// The plugin is loaded for the session only (Claude Code: --plugin-dir; Copilot: an isolated COPILOT_HOME),
// so the developer's own agent setup is never changed. Plugin state goes to a throwaway folder.
//
// Usage: node scripts/agent-e2e.mjs [--scenarios a,b,c] [--plugin <dir>] [--keep]
//   scenarios: claude-tools, claude-setup-unknown, claude-setup-found, copilot-install, copilot-session-start,
//              copilot-teammate
//   --plugin   the built plugin to test (default: ./plugin; run npm run build first)
//   --keep     keep the work folder, transcripts and any pull request opened
// Env: GH_TOKEN (git and gh access to the fixture repos), CLAUDE_BIN (if claude isn't on the PATH),
//      AGENT_MODEL (optional model for Claude Code). Fixtures come from tests/fixtures.json.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const FX = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures.json'), 'utf8'));
const ALL = ['claude-tools', 'claude-setup-unknown', 'claude-setup-found', 'copilot-install', 'copilot-session-start', 'copilot-teammate'];
const SCENARIOS = (opt('--scenarios') || ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = args.includes('--keep');
const WORK = mkdtempSync(join(realpathSync(tmpdir()), 'cartwright-agents-'));
const STATE = join(WORK, 'state');

const which = (c) => { const r = spawnSync('/usr/bin/which', [c], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (which('claude')) return which('claude');
  const ext = join(homedir(), '.vscode', 'extensions');
  if (!existsSync(ext)) return null;
  const dirs = readdirSync(ext).filter((d) => d.startsWith('anthropic.claude-code-')).sort().reverse();
  for (const d of dirs) { const p = join(ext, d, 'resources', 'native-binary', 'claude'); if (existsSync(p)) return p; }
  return null;
}
const CLAUDE = findClaude();
const COPILOT = which('copilot');
const EXPECT = which('expect');

// Bare PATH for the agents' own commands: the runtimes a developer must have, nothing else.
const BIN = join(WORK, 'bin'); mkdirSync(BIN);
for (const c of ['node', 'npx', 'npm', 'git', 'gh']) if (which(c)) symlinkSync(which(c), join(BIN, c));
const gitAuth = process.env.GH_TOKEN ? { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' } : {};
const ENV = { ...process.env, ...gitAuth, PATH: `${BIN}:/usr/bin:/bin`, SHELL: '/bin/sh', CARTWRIGHT_STATE_DIR: STATE, NO_COLOR: '1' };
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 900000, env: ENV, ...o });

// The plugin under test, with the fixture registry so the made-up client can be found.
const PLUGIN = join(WORK, 'plugin');
cpSync(resolve(opt('--plugin', join(ROOT, 'plugin'))), PLUGIN, { recursive: true });
cpSync(join(ROOT, FX.registry), join(PLUGIN, 'tools', 'registry.json'));
const PINS = JSON.parse(readFileSync(join(PLUGIN, 'tools', 'versions.json'), 'utf8'));

let clones = 0;
const clone = (name, branch) => {
  const d = join(WORK, `${name}${clones++ ? `-${clones}` : ''}`);
  const r = sh('git', ['clone', '-q', ...(branch ? ['--branch', branch] : []), `https://github.com/${FX.client}.git`, d]);
  if (r.status !== 0) throw new Error(`clone ${FX.client}: ${r.stderr.trim()}`);
  return d;
};

// --- Claude Code driver ---------------------------------------------------------------------------------
const transcripts = [];
function claude(cwd, messages, label) {
  let sid = null;
  const turns = [];
  for (const msg of messages) {
    const a = ['-p', msg, '--plugin-dir', PLUGIN, '--setting-sources', 'project,local', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', 'Bash(node:*)', 'Bash(git:*)', 'Bash(gh:*)', 'Bash(cd:*)', 'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Skill',
      ...(process.env.AGENT_MODEL ? ['--model', process.env.AGENT_MODEL] : []), ...(sid ? ['--resume', sid] : [])];
    const r = sh(CLAUDE, a, { cwd });
    const lines = r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const tools = [];
    for (const l of lines) if (l.type === 'assistant') for (const c of l.message.content || []) if (c.type === 'tool_use') tools.push({ name: c.name, input: c.input });
    const res = lines.find((l) => l.type === 'result');
    if (!res) throw new Error(`no result for "${msg}": ${(r.stderr || '').slice(0, 200)}`);
    sid = res.session_id;
    turns.push({ msg, tools, result: res.result || '', cost: res.total_cost_usd || 0 });
  }
  transcripts.push({ label, turns });
  return turns;
}
const commands = (turns) => turns.flatMap((t) => t.tools.filter((x) => x.name === 'Bash').map((x) => x.input.command || ''));
const skillsUsed = (turns) => turns.flatMap((t) => t.tools.filter((x) => x.name === 'Skill').map((x) => x.input.skill || ''));
const INSTALLS = /\b(npm\s+(i|install)\s+(-g|--global)|uv\s+tool\s+install|brew\s+install|pip3?\s+install)\b/;
const state = () => { try { return JSON.parse(readFileSync(join(STATE, 'projects.json'), 'utf8')); } catch { return {}; } };

// --- scenarios --------------------------------------------------------------------------------------------
const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
function scenario(name, needs, fn) {
  if (!SCENARIOS.includes(name)) return;
  const missing = needs.filter(([, ok]) => !ok).map(([what]) => what);
  if (missing.length) { results.push({ name, ok: null, detail: `skipped: needs ${missing.join(', ')}` }); return; }
  // Agents aren't deterministic: retry a failure once. Passing on the retry is reported as flaky (a real
  // reliability problem to look at), never as a clean pass.
  let first;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const d = fn() || ''; results.push({ name, ok: true, flaky: attempt === 2, detail: attempt === 2 ? `FLAKY (passed on retry; first try: ${first}) ${d}` : d }); return; }
    catch (e) { const msg = String(e.message || e).split('\n')[0].slice(0, 300); if (attempt === 2) { results.push({ name, ok: false, detail: msg }); return; } first = msg; }
  }
}

scenario('claude-tools', [['Claude Code', CLAUDE]], () => {
  const dir = mkdtempSync(join(WORK, 'empty-'));
  const t = claude(dir, ["What version of the B2C CLI can I use on this machine? Don't install anything."], 'claude-tools');
  const cmds = commands(t);
  assert(cmds.some((c) => c.includes('run.mjs')), `never used the helper; ran: ${cmds.join(' | ').slice(0, 200) || '(nothing)'}`);
  assert(!cmds.some((c) => INSTALLS.test(c)), `tried to install: ${cmds.find((c) => INSTALLS.test(c))}`);
  assert(t[0].result.includes(PINS['b2c-cli']), `answer doesn't mention ${PINS['b2c-cli']}: ${t[0].result.slice(0, 160)}`);
  return `used ${skillsUsed(t).join(', ') || 'the helper'}; answered ${PINS['b2c-cli']}; installed nothing`;
});

scenario('claude-setup-unknown', [['Claude Code', CLAUDE], ['GH_TOKEN', process.env.GH_TOKEN]], () => {
  const dir = clone('unknown');
  const t = claude(dir, ["Hi, I'm starting on this project today.", 'set up', FX.unknown, 'not now'], 'claude-setup-unknown');
  assert(/set up/i.test(t[0].result) && /client/i.test(t[0].result), `didn't offer setup first: ${t[0].result.slice(0, 160)}`);
  const cmds = commands(t);
  assert(cmds.some((c) => /setup\.mjs"?\s+lookup/.test(c) && c.includes(FX.unknown)), 'never looked the client up');
  assert(cmds.some((c) => /remember\s+later/.test(c)), 'didn\'t record "not now"');
  assert(!cmds.some((c) => /git\s+(commit|push)/.test(c)), 'changed the repo');
  const s = Object.entries(state()).find(([k]) => k === dir);
  assert(s?.[1].choice === 'later', `state: ${JSON.stringify(s)}`);
  return 'offered once, looked up, found nothing, remembered "not now", repo untouched';
});

let prUrl = null;
scenario('claude-setup-found', [['Claude Code', CLAUDE], ['GH_TOKEN', process.env.GH_TOKEN]], () => {
  // A pull request or branch left by an earlier run would make the agent's push fail: clear them first.
  for (const n of JSON.parse(sh('gh', ['pr', 'list', '-R', FX.client, '--state', 'open', '--json', 'number,headRefName']).stdout || '[]'))
    if (/^chore\/cartwright/.test(n.headRefName)) sh('gh', ['pr', 'close', String(n.number), '-R', FX.client, '--delete-branch']);
  sh('gh', ['api', '-X', 'DELETE', `repos/${FX.client}/git/refs/heads/chore/cartwright-setup`]);
  const dir = clone('found');
  // Generic yeses keep the answers valid whatever order the agent asks its questions in.
  const t = claude(dir, ["Hi, I'm starting on this project today.", 'set up', FX.alias, "Yes, that's the right client.", 'Yes, go ahead.', 'Yes, go ahead.', "No thanks, that's all for now."], 'claude-setup-found');
  const cmds = commands(t);
  assert(skillsUsed(t).some((s) => s.endsWith('client-setup')), 'client-setup skill not used');
  assert(cmds.some((c) => /setup\.mjs"?\s+lookup/.test(c)), 'never looked the client up');
  assert(cmds.some((c) => /\baccess\b/.test(c) && (c.includes(FX.overlay) || c.includes(FX.core))), 'never checked access');
  assert(cmds.some((c) => /setup\.mjs"?\s+kit/.test(c)), 'never added the kit');
  const branch = sh('git', ['branch', '--show-current'], { cwd: dir }).stdout.trim();
  const pr = sh('gh', ['pr', 'list', '-R', FX.client, '--head', branch, '--state', 'open', '--json', 'url,files', '--jq', '.[0]']);
  const info = pr.stdout.trim() ? JSON.parse(pr.stdout) : null;
  assert(info, `no open pull request from ${branch}`);
  prUrl = info.url;
  const files = info.files.map((f) => f.path).sort().join(',');
  assert(files === '.agents/plugins/marketplace.json,.claude/settings.json,.codex/config.toml,.github/copilot/settings.json,AGENT-SKILLS.md', `PR files: ${files}`);
  return `found ${FX.code} from "${FX.alias}", access checked, kit added, PR ${prUrl}`;
});

scenario('copilot-install', [['Copilot CLI', COPILOT]], () => {
  const env = { ...ENV, COPILOT_HOME: join(WORK, 'copilot-install') };
  const add = sh(COPILOT, ['plugin', 'marketplace', 'add', opt('--plugin') ? ROOT : FX.core], { env });
  assert(add.status === 0, `marketplace add: ${(add.stdout + add.stderr).trim().slice(0, 200)}`);
  const inst = sh(COPILOT, ['plugin', 'install', 'cartwright@cartwright'], { env });
  const n = Number((inst.stdout.match(/Installed (\d+) skills/) || [])[1] || 0);
  assert(inst.status === 0 && n >= 50, `install: ${(inst.stdout + inst.stderr).trim().slice(0, 200)}`);
  return `fresh install: ${n} skills`;
});

scenario('copilot-session-start', [['Copilot CLI', COPILOT]], () => {
  // The session-start hook must run in Copilot too and its notes must reach the agent. Installed from the
  // marketplace, in a fresh git folder on a bare PATH (so the missing-tools note is due): the opt-in trace
  // proves the hook ran, and the agent's first reply shows it got the note. (Copilot's model doesn't reliably
  // open with the setup question even when it receives it: a known limitation, documented, not asserted.)
  const home = mkdtempSync(join(WORK, 'copilot-session-start-'));
  const dir = mkdtempSync(join(WORK, 'fresh-'));
  const trace = join(WORK, `hook-trace-${Date.now()}`);
  sh('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ trustedFolders: [dir] }, null, 2));
  const env = { ...ENV, COPILOT_HOME: home, CARTWRIGHT_HOOK_TRACE: trace };
  const add = sh(COPILOT, ['plugin', 'marketplace', 'add', opt('--plugin') ? ROOT : FX.core], { env });
  assert(add.status === 0, `marketplace add: ${(add.stdout + add.stderr).trim().slice(0, 200)}`);
  const inst = sh(COPILOT, ['plugin', 'install', 'cartwright@cartwright'], { env });
  assert(inst.status === 0, `install: ${(inst.stdout + inst.stderr).trim().slice(0, 200)}`);
  // Only the hook's note carries the helper's full path, so quoting it proves the note reached the agent.
  const ask = sh(COPILOT, ['-p', "Without running any tools: what is the full path of the helper you've been told to use to run b2c here? Reply with just the path, or NONE.", '-s', '--no-color'], { cwd: dir, env });
  const said = ask.stdout.trim();
  assert(existsSync(trace) && readFileSync(trace, 'utf8').includes('session-start'), 'the session-start hook never ran in Copilot');
  assert(/\/tools\/run\.mjs/.test(said), `hook ran, but its note didn't reach the agent: ${said.slice(0, 160)}`);
  return `hook ran (trace) and its note reached the agent (it quoted ${said.match(/\S*\/tools\/run\.mjs/)?.[0].split('/').slice(-3).join('/')})`;
});

scenario('copilot-teammate', [['Copilot CLI', COPILOT], ['expect', EXPECT], ['GH_TOKEN', process.env.GH_TOKEN]], () => {
  // A teammate's clone of a project that already has the kit (added locally; its pointers are on GitHub).
  const dir = clone('teammate');
  const kit = sh('node', [join(PLUGIN, 'tools', 'setup.mjs'), 'kit', '--code', FX.code, '--overlay', FX.overlay], { cwd: dir });
  assert(kit.status === 0, `kit: ${kit.stderr}`);
  const home = join(WORK, 'copilot-teammate'); mkdirSync(home);
  for (const f of ['config.json', 'settings.json']) writeFileSync(join(home, f), JSON.stringify({ trustedFolders: [dir] }, null, 2));
  const env = { ...ENV, COPILOT_HOME: home };
  // Copilot applies declared plugins when an interactive session starts; drive one with expect.
  const exp = join(WORK, 'copilot.exp');
  writeFileSync(exp, `set timeout 120\nspawn ${COPILOT}\nexpect { -re "(?i)trust" { send "\\r"; exp_continue } timeout {} }\nsleep 25\nsend "/exit\\r"\nexpect eof\n`);
  sh(EXPECT, [exp], { cwd: dir, env, timeout: 300000 });
  const list = sh(COPILOT, ['plugin', 'list'], { cwd: dir, env }).stdout;
  assert(list.includes('cartwright@cartwright') && list.includes(`${FX.code}-skills@${FX.code}-cartwright`), `plugins after start: ${list.trim().replace(/\s+/g, ' ')}`);
  const ask = sh(COPILOT, ['-p', "What's our release checklist for this storefront? Answer briefly and name the skill you used.", '-s', '--no-color'], { cwd: dir, env });
  assert(ask.stdout.includes(FX.projectSkill), `didn't use ${FX.projectSkill}: ${ask.stdout.trim().slice(0, 160)}`);
  return `both plugins installed on start; answered with ${FX.projectSkill}`;
});

// --- report and clean up ----------------------------------------------------------------------------------
if (prUrl && !KEEP) sh('gh', ['pr', 'close', prUrl, '--delete-branch', '--comment', 'Closed by scripts/agent-e2e.mjs.']);
const cost = transcripts.flatMap((t) => t.turns).reduce((s, t) => s + t.cost, 0);
console.log('## Agent scenarios\n\n| | Scenario | Result |\n|---|---|---|');
for (const r of results) console.log(`| ${r.ok === null ? '⏭️' : r.flaky ? '⚠️' : r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`);
if (cost) console.log(`\nClaude Code usage: $${cost.toFixed(2)}`);
if (KEEP) { writeFileSync(join(WORK, 'transcripts.json'), JSON.stringify(transcripts, null, 2)); console.log(`\nWork folder and transcripts kept: ${WORK}`); }
else rmSync(WORK, { recursive: true, force: true });
process.exit(results.some((r) => r.ok === false) ? 1 : 0);
