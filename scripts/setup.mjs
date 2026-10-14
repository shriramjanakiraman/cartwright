#!/usr/bin/env node
// Session-start and client setup helper. Shipped in the plugin (plugin/tools/) and called by the session-start hook,
// the project-profile skill and the client-setup skill, in Claude Code, Codex, GitHub Copilot CLI and VS Code alike.
// No dependencies.
//
//   node setup.mjs hook                       session start: the setup offer when there's something to offer, a
//                                             warning when the guardrails are broken or inactive, the project's
//                                             profile (grounding) and whether it's out of date, and the tools note
//   node setup.mjs status                     JSON: project root, git remote, kit, remembered choice, profile
//   node setup.mjs lookup "<client name>"     JSON: registered clients matching the name (any spelling/initials)
//   node setup.mjs access <repo>              JSON: can this machine's git credentials read the repo?
//   node setup.mjs kit --code <c> --overlay <repo> [--lead <who>]   add the client project kit to this project
//   node setup.mjs install --code <c> --overlay <repo>              per-agent commands to install right now
//   node setup.mjs remember <done|later|never|no-client>            record the choice for this project
// <repo> is owner/repo for GitHub, or any git URL (GitLab, Bitbucket, self-hosted). Options --dir <path>
// run against another project folder instead of the current one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyKit, CORE_REPO, gitUrl, names, readKit } from './kit.mjs';
import { lookup } from './registry-core.mjs';
import { TOOLS, which } from './run.mjs';
import { resolveSettings } from './settings.mjs';
import { load, stateDir } from './store.mjs';

// Session-start notes, in the order the agent sees them: the setup offer first (agents act on what comes first),
// then warnings about the guardrails, the project's profile and whether it's out of date, and the tools note. Each
// agent reads it in its own shape: Claude Code takes plain text on stdout; GitHub Copilot only JSON
// {"additionalContext": "..."}; Codex only JSON {"hookSpecificOutput": {"hookEventName": "SessionStart",
// "additionalContext": "..."}} (0.162.1 rejects plain text as "invalid session start JSON output" and drops it).
const notes = { setup: '', guard: '', grounding: '', drift: '', tools: '' };
const IN_COPILOT = !!(process.env.COPILOT_PLUGIN_ROOT || process.env.COPILOT_CLI);
// Codex sets PLUGIN_ROOT (and CLAUDE_PLUGIN_ROOT), but no Copilot variable; Claude Code sets only CLAUDE_PLUGIN_ROOT. The
// guard tells the agents apart the same way.
const IN_CODEX = !IN_COPILOT && !!process.env.PLUGIN_ROOT;
// VS Code (GitHub Copilot Chat agent mode) sets CLAUDE_PLUGIN_ROOT and its own VSCODE_* variables; it reads plain text.
// Claude Code started from VS Code's terminal inherits VSCODE_* but also sets CLAUDECODE.
const IN_VSCODE = !IN_COPILOT && !IN_CODEX && !!(process.env.VSCODE_PID || process.env.VSCODE_IPC_HOOK) && !process.env.CLAUDECODE;
// The project the session-start hook chose, for the trace.
let traceRoot = null;
function flushNotes() {
  const ctx = [notes.setup, notes.guard, notes.grounding, notes.drift, notes.tools].filter(Boolean).join('\n\n');
  if (ctx) process.stdout.write(IN_COPILOT ? JSON.stringify({ additionalContext: ctx })
    : IN_CODEX ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }) : `${ctx}\n`);
  // CARTWRIGHT_HOOK_TRACE (tests only): also record the project chosen and exactly what the agent was given.
  if (process.env.CARTWRIGHT_HOOK_TRACE) { try { writeFileSync(process.env.CARTWRIGHT_HOOK_TRACE, `${JSON.stringify({ event: 'session-context', root: traceRoot, context: ctx })}\n`, { flag: 'a' }); } catch { /* tracing is optional */ } }
}
// The hook's input from the agent (JSON on stdin), or null. Every agent sends the session's folder as `cwd`. Waits at most
// `ms` for it, so a stdin that stays open and silent can't hold up the session.
const readPayload = (ms) => new Promise((done) => {
  if (process.stdin.isTTY) { done(null); return; }
  let buf = '', over = false;
  const finish = () => {
    if (over) return; over = true; clearTimeout(timer);
    process.stdin.removeAllListeners('data'); process.stdin.removeAllListeners('end');
    try { process.stdin.destroy(); } catch { /* already closed */ }
    let j = null; try { j = buf.trim() ? JSON.parse(buf) : null; } catch { /* not JSON */ }
    done(j && typeof j === 'object' ? j : null);
  };
  const timer = setTimeout(finish, ms);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { buf += d; if (buf.length > 1e6) finish(); });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
});
// The session's project folder: --dir, then the payload's cwd, then the agents' project variables, then the hook's own
// folder, but never the plugin's own folder (an agent may start plugin hooks there).
async function sessionDir() {
  if (opt('--dir')) return resolve(opt('--dir'));
  const p = await readPayload(300);
  const given = [typeof p?.cwd === 'string' ? p.cwd : null, process.env.CLAUDE_PROJECT_DIR, process.env.COPILOT_PROJECT_DIR].find((x) => x);
  if (given) return resolve(given);
  const real = (x) => { try { return realpathSync(x); } catch { return resolve(x); } };
  const here = real(process.cwd());
  if (PLUGIN_ROOT && (here === real(PLUGIN_ROOT) || here.startsWith(real(PLUGIN_ROOT) + sep))) return null;
  return here;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
// Per-user state; CARTWRIGHT_STATE_DIR moves it (the end-to-end tests use a throwaway folder).
const STATE = join(process.env.CARTWRIGHT_STATE_DIR || join(homedir(), '.cartwright'), 'projects.json');
const ASK_AGAIN_DAYS = 7;
// The drift check at session start is time-boxed; past this it's skipped silently (design 4, E45).
const DRIFT_BUDGET_MS = 120;
// The plugin folder this helper runs from (tools/ inside it), or null when run from a library clone.
const PLUGIN_ROOT = basename(dirname(fileURLToPath(import.meta.url))) === 'tools' ? dirname(dirname(fileURLToPath(import.meta.url))) : null;
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
// The Cartwright repo itself (or a clone from before the rename), or an overlay repo: never offer setup there.
function isLibraryRepo(root) {
  if (existsSync(join(root, 'overlay.json'))) return true;
  try { return ['cartwright', 'agent-skills'].includes(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name); } catch { return false; }
}

const dir = resolve(opt('--dir') || process.cwd());
const [cmd] = args;

// The offer at session start (design 4): which line, given whether the project is profiled and whether the client
// is known (the kit, clientProject in the settings, or a remembered "no client" or "done").
export const OFFERS = {
  combined: 'Cartwright can study this project (read-only) and save a profile so I use its real commands and rules, and connect it to a client\'s project skills if it\'s for a client. Reply set up, not now, or never here.',
  profile: 'Cartwright can study this project (read-only) and save a profile so I use its real commands and rules. Reply set up, not now, or never here.',
  client: 'Is this project for a client? I can connect it to that client\'s project skills. Reply set up, not now, or never here.',
  connect: 'This project is for a client but isn\'t connected to its project skills yet. Reply set up, not now, or never here.',
};

// Where the guard can be found from this agent, as the PreToolUse trampoline looks: null when it can be, else why not.
function guardMissing() {
  if (process.platform === 'win32') return "hard blocks aren't available on Windows (the hooks run through sh)";
  if (!which('node')) return "node isn't on the PATH the hooks use";
  const roots = [process.env.CLAUDE_PLUGIN_ROOT, process.env.COPILOT_PLUGIN_ROOT, process.env.PLUGIN_ROOT];
  try { roots.push(readFileSync(join(stateDir(), 'plugin-root'), 'utf8').trim()); } catch { /* no cached root */ }
  return roots.some((d) => d && existsSync(join(d, 'tools', 'guard.mjs'))) ? null : "the guard can't be found from this agent (no plugin-root variable, and no cached plugin root)";
}

if (cmd === 'hook') {
  // Must stay fast: no network, no key derivation, nothing written in the project. Each part runs on its own, so a
  // failure in one never breaks the session or the others.
  // CARTWRIGHT_HOOK_TRACE (tests only): append a line to that file, so a test can prove the hook ran.
  const hookDir = await sessionDir();
  if (process.env.CARTWRIGHT_HOOK_TRACE) { try { writeFileSync(process.env.CARTWRIGHT_HOOK_TRACE, `session-start ${hookDir}\n`, { flag: 'a' }); } catch { /* tracing is optional */ } }
  // 1. Tools the skills use that aren't installed here: tell the agent how to run them anyway.
  try {
    const RUN = join(HERE, 'run.mjs');
    const missing = Object.values(TOOLS).filter((t) => !which(t.bin)).map((t) => t.bin);
    if (missing.length && existsSync(RUN)) notes.tools = (`[cartwright] Not installed on this machine: ${missing.join(', ')}. When a skill or the user says to run one of them, don't install it: run node "${RUN}" <tool> <same arguments> instead (for example node "${RUN}" ${missing[0]} --help). It fetches the team's pinned version on first use. Check prerequisites with node "${RUN}" --check; the tools-without-install skill has the details.`);
  } catch { /* never block a session */ }
  // The plugin-root cache, for an agent that sets no plugin-root variable: written only when it changes.
  try {
    if (PLUGIN_ROOT && existsSync(join(PLUGIN_ROOT, 'tools', 'guard.mjs'))) {
      const f = join(stateDir(), 'plugin-root');
      let had = null; try { had = readFileSync(f, 'utf8').trim(); } catch { /* first time */ }
      if (had !== PLUGIN_ROOT) { mkdirSync(stateDir(), { recursive: true }); writeFileSync(f, `${PLUGIN_ROOT}\n`); }
    }
  } catch { /* the cache is a safety net only */ }
  let root = null, st = null, resolved = null;
  // The project: the nearest folder with .git, found without running git (the same real path git would give).
  try { if (hookDir) for (let d = realpathSync(hookDir); ; d = dirname(d)) { if (existsSync(join(d, '.git'))) { root = d; break; } if (d === dirname(d)) break; } } catch { /* not a project */ }
  traceRoot = root;
  try {
    if (root) {
      st = load(root);
      const profile = st.profile.status === 'ok' ? st.profile.data : null;
      resolved = resolveSettings({ team: st.settings, personal: st.personal, profile });
    }
  } catch { /* unreadable storage: the guard reports it on each block */ }
  // 2. Guardrail health: broken settings, a personal file trying to loosen team rules, storage notes, and whether
  //    the guard can run here at all.
  try {
    const say = [];
    const missing = guardMissing();
    if (missing) say.push(`[cartwright] Guardrails are inactive in this agent: ${missing}. Pushes to protected branches, secrets, generated files and deletions outside the project won't be blocked here, so take extra care, and tell the person once.`);
    if (resolved?.status === 'broken') say.push(`[cartwright] ${resolved.message} Tell the person once, in your first reply.`);
    if (resolved?.loosening?.length) say.push(`[cartwright] The personal file tries to loosen team rules, which it can't (the personal file can only add or tighten rules): ${resolved.loosening.map((l) => l.split(':')[0]).join(', ')}.`);
    if (st?.found.length > 1) say.push(`[cartwright] Cartwright's profile and settings are stored in more than one place (${st.found.join(', ')}); the ${st.found[0] === 'folder' ? '.cartwright/ folder' : st.found[0] === 'agents-md' ? 'AGENTS.md section' : 'copy on this machine'} is used. Mention it once.`);
    for (const n of st?.notes || []) say.push(`[cartwright] ${n}`);
    notes.guard = say.join('\n');
  } catch { /* never block a session */ }
  // 3 and 4. Grounding, and drift: re-detect in-process (never by spawning profile.mjs check), time-boxed.
  try {
    if (st?.profile.status === 'ok') {
      const m = await import(pathToFileURL(join(HERE, 'profile.mjs')));
      if (!m.validateProfile(st.profile.data).length) {
        let stale = new Set();
        try {
          const fresh = m.detect(root, { suggestions: false, deadline: Date.now() + DRIFT_BUDGET_MS });
          const changes = m.compare(st.profile.data, fresh, { quick: true });
          if (changes.length) {
            stale = new Set(changes.map((c) => c.key));
            notes.drift = `[cartwright] The project profile is out of date: ${changes.map((c) => c.key.replace(/^facts\./, '')).join(', ')} changed since it was saved. Mention this once in this session, and offer to refresh it (the project-profile skill: node "${join(HERE, 'profile.mjs')}" diff shows exactly what changed). Until then, trust the project's files over the facts marked [out of date].`;
          }
        } catch { /* over the time box, or detection failed: skip silently */ }
        const file = st.mode === 'folder' ? st.profile.file : st.mode === 'agents-md' ? 'the Cartwright section of AGENTS.md' : 'saved on this machine only';
        notes.grounding = m.groundingText(st.profile.data, { file, stale, settings: resolved?.status === 'none' ? null : resolved?.settings, profileCmd: `node "${join(HERE, 'profile.mjs')}"`, folder: basename(root) });
        // VS Code: one window can hold several folders, and its hooks get the first one as the session's folder.
        if (IN_VSCODE) notes.grounding += `\nThis window may have several folders, and Cartwright's guardrails judge terminal commands from the first one: start terminal commands for another folder with cd "<absolute folder>" &&.`;
      }
    }
  } catch { /* never block a session */ }
  // 5. The offer, for projects not set up: unless "never here", "not now" within 7 days, or a library/overlay repo.
  try {
    const s = root ? loadState()[root] : null;
    const quiet = s?.choice === 'never' || (s?.choice === 'later' && Date.now() - s.at < ASK_AGAIN_DAYS * 864e5);
    if (root && !isLibraryRepo(root) && !quiet) {
      const profiled = !!st && st.profile.status !== 'none';
      const team = st?.settings.status === 'ok' ? st.settings.data : null;
      const clientKnown = !!readKit(root) || team?.clientProject === false || !!s?.noClient || !!s?.done || ['no-client', 'done'].includes(s?.choice);
      // clientProject: true with no kit: it's recorded as a client project, so offer to connect it, not ask again.
      const line = !profiled ? (clientKnown ? 'profile' : 'combined') : clientKnown ? null : team?.clientProject === true ? 'connect' : 'client';
      if (line) notes.setup = (`[cartwright] ${line === 'client' ? `This project (${root}) has a Cartwright profile but isn't connected to a client's project skills, and it isn't recorded whether it's for a client.` : line === 'connect' ? `This project (${root}) is recorded as a client project (clientProject in its settings) but has no client project kit yet.` : `This project (${root}) isn't set up with Cartwright yet.`}
REQUIRED: begin your very first reply in this session with this one line, before answering anything else:
"${OFFERS[line]}"
Then answer the user's message as usual.
- "set up": follow the ${['client', 'connect'].includes(line) ? 'client-setup' : 'project-profile'} skill. Its helpers are: node "${SELF}"${['client', 'connect'].includes(line) ? '' : ` and node "${join(HERE, 'profile.mjs')}"`}
- "not now": run node "${SELF}" remember later --dir "${root}" (asks again in ${ASK_AGAIN_DAYS} days)
- "never here": run node "${SELF}" remember never --dir "${root}"
Then carry on with what the user asked. Don't raise it again in this session.`);
    }
  } catch { /* never block a session */ }
  flushNotes();
  process.exit(0);
}

if (cmd === 'status') {
  const root = projectRoot(dir);
  const remote = root ? git(root, 'remote', 'get-url', 'origin') : null;
  // The profile facts other skills need (design 6, C27): where it's stored, the host and PR template for the pull
  // request, whether it's for a client, and the default branch.
  let profile = null;
  if (root) {
    const st = load(root);
    if (st.mode) {
      const p = st.profile.status === 'ok' ? st.profile.data : null;
      const r = resolveSettings({ team: st.settings, personal: st.personal, profile: p });
      const head = git(root, 'symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD');
      profile = { store: st.mode, file: st.profile.file, profile: st.profile.status, settings: r.status,
        remoteHost: p?.facts?.remoteHost?.status === 'found' ? p.facts.remoteHost.value : null,
        prTemplate: p?.conventions?.prTemplate?.status === 'found' ? p.conventions.prTemplate.path : null,
        clientProject: st.settings.status === 'ok' && typeof st.settings.data.clientProject === 'boolean' ? st.settings.data.clientProject : null,
        defaultBranch: head.status === 0 ? head.stdout.trim().replace(/^[^/]+\//, '') : null };
    }
  }
  out({ projectRoot: root, isGitRepo: !!root, libraryRepo: root ? isLibraryRepo(root) : false,
    remote: remote && remote.status === 0 ? remote.stdout.trim() : null,
    kit: root ? readKit(root) : null, remembered: root ? loadState()[root] || null : null, profile,
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
  let changed;
  try { changed = applyKit(root, { code, overlay, lead: opt('--lead') }); }
  catch (e) { console.error(`setup: ${e.message}`); process.exit(1); }
  out({ projectRoot: root, changed, notes: changed.notes });
  process.exit(0);
}

if (cmd === 'install') {
  const code = opt('--code'), overlay = opt('--overlay');
  if (!code || !overlay) { console.error('setup: install needs --code and --overlay'); process.exit(2); }
  const { marketplace, plugin } = names(code);
  out({
    'claude-code': [`claude plugin marketplace add ${CORE_REPO}`, 'claude plugin install cartwright@cartwright',
      `claude plugin marketplace add ${overlay}`, `claude plugin install ${plugin}@${marketplace}`],
    codex: [`codex plugin marketplace add ${CORE_REPO}`, 'codex plugin add cartwright@cartwright',
      `codex plugin marketplace add ${overlay}`, `codex plugin add ${plugin}@${marketplace}`],
    'copilot-cli': [`copilot plugin marketplace add ${CORE_REPO}`, 'copilot plugin install cartwright@cartwright',
      `copilot plugin marketplace add ${overlay}`, `copilot plugin install ${plugin}@${marketplace}`],
    vscode: [`Command Palette → "Chat: Install Plugin From Source" → ${CORE_REPO}`, `… then again with ${overlay}`],
  });
  process.exit(0);
}

if (cmd === 'remember') {
  const choice = args[1];
  if (!['done', 'later', 'never', 'no-client'].includes(choice)) { console.error('setup: remember done | later | never | no-client'); process.exit(2); }
  const root = projectRoot(dir) || dir;
  const s = loadState();
  // "No client" and "done" are kept when a later answer (not now, never here) replaces the choice, so the client question
  // isn't asked again.
  const noClient = choice === 'no-client' || !!s[root]?.noClient;
  const done = choice === 'done' || !!s[root]?.done;
  s[root] = { choice, at: Date.now(), ...(noClient ? { noClient: true } : {}), ...(done ? { done: true } : {}) };
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
  out({ projectRoot: root, remembered: choice });
  process.exit(0);
}

console.error('usage: setup.mjs hook | status | lookup "<name>" | access <repo> | kit --code c --overlay r | install --code c --overlay r | remember <choice>');
process.exit(2);
