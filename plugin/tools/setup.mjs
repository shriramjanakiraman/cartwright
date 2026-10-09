#!/usr/bin/env node
// Client setup helper. Shipped in the plugin (plugin/tools/) and called by the session-start hook and the
// client-setup skill, in Claude Code, Codex, GitHub Copilot CLI and VS Code alike. No dependencies.
//
//   node setup.mjs hook                       session start: prints a short instruction for the agent when
//                                             this project hasn't been set up yet; otherwise prints nothing
//   node setup.mjs status                     JSON: project root, git remote, kit, remembered choice
//   node setup.mjs lookup "<client name>"     JSON: registered clients matching the name (any spelling/initials)
//   node setup.mjs access <repo>              JSON: can this machine's git credentials read the repo?
//   node setup.mjs kit --code <c> --overlay <repo> [--lead <who>]   add the client project kit to this project
//   node setup.mjs install --code <c> --overlay <repo>              per-agent commands to install right now
//   node setup.mjs remember <done|later|no-client>                  record the choice for this project
// <repo> is owner/repo for GitHub, or any git URL (GitLab, Bitbucket, self-hosted). Options --dir <path>
// run against another project folder instead of the current one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyKit, CORE_REPO, gitUrl, names, readKit } from './kit.mjs';
import { lookup } from './registry-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const STATE = join(homedir(), '.agent-skills', 'projects.json');
const ASK_AGAIN_DAYS = 7;
const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : undefined; };
const out = (o) => console.log(JSON.stringify(o, null, 2));

const git = (dir, ...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
function projectRoot(start) {
  const r = git(start, 'rev-parse', '--show-toplevel');
  return r.status === 0 ? r.stdout.trim() : null;
}
const loadState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
function registry() {
  for (const p of [join(HERE, 'registry.json'), join(HERE, '..', 'registry', 'overlays.json')]) {
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  }
  return { entries: [] };
}
// The agent-skills repo itself, or an overlay repo: never offer client setup there.
function isLibraryRepo(root) {
  if (existsSync(join(root, 'overlay.json'))) return true;
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name === 'agent-skills'; } catch { return false; }
}

const dir = resolve(opt('--dir') || process.cwd());
const [cmd] = args;

if (cmd === 'hook') {
  // Must stay fast and silent unless there is something to offer: no network, no key derivation.
  try {
    const root = projectRoot(dir);
    if (!root || isLibraryRepo(root) || readKit(root)) process.exit(0);
    const s = loadState()[root];
    if (s && (s.choice !== 'later' || Date.now() - s.at < ASK_AGAIN_DAYS * 864e5)) process.exit(0);
    console.log(`[agent-skills] This project (${root}) isn't set up for client project skills yet.
In your first reply, before anything else, ask the user once, in one short line: whether this project is for a
client, and offer to connect it to that client's project skills (answers: "set up", "not now", "no client").
- "set up": follow the client-setup skill. Its helper is: node "${SELF}"
- "not now": run node "${SELF}" remember later --dir "${root}" (asks again in ${ASK_AGAIN_DAYS} days)
- "no client": run node "${SELF}" remember no-client --dir "${root}"
Then carry on with what the user asked. Don't raise it again in this session.`);
  } catch { /* never block a session */ }
  process.exit(0);
}

if (cmd === 'status') {
  const root = projectRoot(dir);
  const remote = root ? git(root, 'remote', 'get-url', 'origin') : null;
  out({ projectRoot: root, isGitRepo: !!root, libraryRepo: root ? isLibraryRepo(root) : false,
    remote: remote && remote.status === 0 ? remote.stdout.trim() : null,
    kit: root ? readKit(root) : null, remembered: root ? loadState()[root] || null : null,
    registeredClients: (registry().entries || []).length > 0 });
  process.exit(0);
}

if (cmd === 'lookup') {
  const name = args.slice(1).filter((a, i, l) => !a.startsWith('--') && l[i - 1] !== '--dir').join(' ');
  if (!name) { console.error('setup: give the client name to look up'); process.exit(2); }
  out({ name, matches: lookup(registry(), name) });
  process.exit(0);
}

if (cmd === 'access') {
  const repo = args[1];
  if (!repo) { console.error('setup: give the repo to check'); process.exit(2); }
  const r = spawnSync('git', ['ls-remote', '--exit-code', '-h', gitUrl(repo)], { encoding: 'utf8', timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const err = (r.stderr || '').trim().split('\n').pop() || (r.error ? String(r.error.message) : '');
  out({ repo: gitUrl(repo), canRead: r.status === 0 || r.status === 2,
    reason: r.status === 0 || r.status === 2 ? null : /not found|could not read|authentication|permission|denied|403|404/i.test(err)
      ? 'no access with this machine\'s git credentials (or the repo does not exist)' : err || 'git could not reach the repo' });
  process.exit(0);
}

if (cmd === 'kit') {
  const code = opt('--code'), overlay = opt('--overlay');
  if (!code || !overlay) { console.error('setup: kit needs --code and --overlay'); process.exit(2); }
  const root = projectRoot(dir) || dir;
  const changed = applyKit(root, { code, overlay, lead: opt('--lead') });
  out({ projectRoot: root, changed });
  process.exit(0);
}

if (cmd === 'install') {
  const code = opt('--code'), overlay = opt('--overlay');
  if (!code || !overlay) { console.error('setup: install needs --code and --overlay'); process.exit(2); }
  const { marketplace, plugin } = names(code);
  out({
    'claude-code': [`claude plugin marketplace add ${CORE_REPO}`, 'claude plugin install agent-skills@agent-skills',
      `claude plugin marketplace add ${overlay}`, `claude plugin install ${plugin}@${marketplace}`],
    codex: [`codex plugin marketplace add ${CORE_REPO}`, 'codex plugin add agent-skills@agent-skills',
      `codex plugin marketplace add ${overlay}`, `codex plugin add ${plugin}@${marketplace}`],
    'copilot-cli': [`copilot plugin marketplace add ${CORE_REPO}`, 'copilot plugin install agent-skills@agent-skills',
      `copilot plugin marketplace add ${overlay}`, `copilot plugin install ${plugin}@${marketplace}`],
    vscode: [`Command Palette → "Chat: Install Plugin From Source" → ${CORE_REPO}`, `… then again with ${overlay}`],
  });
  process.exit(0);
}

if (cmd === 'remember') {
  const choice = args[1];
  if (!['done', 'later', 'no-client'].includes(choice)) { console.error('setup: remember done | later | no-client'); process.exit(2); }
  const root = projectRoot(dir) || dir;
  const s = loadState();
  s[root] = { choice, at: Date.now() };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
  out({ projectRoot: root, remembered: choice });
  process.exit(0);
}

console.error('usage: setup.mjs hook | status | lookup "<name>" | access <repo> | kit --code c --overlay r | install --code c --overlay r | remember <choice>');
process.exit(2);
