#!/usr/bin/env node
// Deterministic test of the guardrails, against a copy of the built plugin only. Every case in tests/guard-cases.json
// runs in its own copy of a fixture project (with a local bare remote), in the payload shape of each agent it names:
// cases marked via "hook" go through the real hooks.json command (the sh trampoline, node, guard.mjs), the rest call
// the guard in-process. Allowed pushes and commits are then run, to show the remote and the project's own git hooks
// behave. HOME (a symlink), TMPDIR, the state folder and the project all live in unusual places (D35). Also: the
// trampoline without node or with only the cached plugin root, a malformed payload, the decision log, and p50/p95
// timings against the budget (design 5.9). Offline; no agents; free.
//
// Usage: node scripts/e2e-guard.mjs [--plugin ./plugin] [--keep] [--only "<words in a case name>"] [--no-timing | --timing-only]
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, halfTheCpus, harness, sh, workBase } from './e2e-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const KEEP = args.includes('--keep');
const { WORK, BARE, step, report } = harness('cartwright-guard-', { concurrency: halfTheCpus(), base: workBase() });
const PLUGIN = join(WORK, 'plugin');
cpSync(resolve(opt('--plugin', join(ROOT, 'plugin'))), PLUGIN, { recursive: true });

// Unusual places (D35): a symlinked home, a temporary folder that isn't /tmp, the state folder, an allowed location,
// and a folder that's simply outside everything.
const HOME_REAL = join(WORK, 'home real'), HOME = join(WORK, 'home-link');
const TMP = join(WORK, 'unusual-tmp'), STATE = join(WORK, 'state'), ALLOWED = join(WORK, 'allowed-place'), OUTSIDE = join(WORK, 'outside');
for (const d of [join(HOME_REAL, 'precious'), TMP, join(STATE, 'cache', 'b2c'), join(ALLOWED, 'old'), OUTSIDE]) mkdirSync(d, { recursive: true });
writeFileSync(join(HOME_REAL, 'precious', 'file.txt'), 'keep me\n');
writeFileSync(join(HOME_REAL, '.zshrc'), 'export A=1\n');
writeFileSync(join(OUTSIDE, 'a.log'), 'log\n');
symlinkSync(HOME_REAL, HOME);
const env = (extra = {}) => ({ HOME, PATH: BARE, TMPDIR: TMP, CARTWRIGHT_STATE_DIR: STATE, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', ...extra });
// The in-process guard reads the state folder from the environment, like the hook does.
Object.assign(process.env, { CARTWRIGHT_STATE_DIR: STATE, HOME });
const { respond, makeContext, normalise } = await import(pathToFileURL(join(PLUGIN, 'tools', 'guard.mjs')));
const { decide } = await import(pathToFileURL(join(PLUGIN, 'tools', 'guard-rules.mjs')));
const { machineDir } = await import(pathToFileURL(join(PLUGIN, 'tools', 'store.mjs')));
const HOOK = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
const NODE = join(BARE.split(':')[0], 'node');
const AGENT_ENV = {
  'claude-code': { CLAUDE_PLUGIN_ROOT: PLUGIN },
  copilot: { COPILOT_PLUGIN_ROOT: PLUGIN, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN },
  'copilot-camel': { COPILOT_PLUGIN_ROOT: PLUGIN, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN },
  codex: { PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN },
  'codex-exec': { PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN },
};

const git = (cwd, ...a) => { const r = sh('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, env: env() }); assert(r.status === 0, `git ${a.join(' ')}: ${r.stderr.trim()}`); return r.stdout; };
const profileWrite = (dir, ...a) => { const r = sh(NODE, [join(PLUGIN, 'tools', 'profile.mjs'), 'write', ...a], { cwd: dir, env: env() }); assert(r.status === 0, `profile write: ${r.stderr.trim()}`); };
const editJson = (p, fn) => { const j = JSON.parse(readFileSync(p, 'utf8')); fn(j); writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); };
const commitPush = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); git(dir, 'push', '-q', 'origin', 'main'); };
const PROFILED = ['--store', 'folder', '--protected', 'main,develop,release/*', '--generated', 'src/generated/**=pnpm generate:api',
  '--generated', 'src/generated/copy.ts=cp src/server.ts src/generated/copy.ts',
  '--secrets-allow', 'tests/fixtures/**', '--allow-location', ALLOWED, '--protect-location', 'vault'];
const RULES = [
  { id: 'no-prod-deploy', shell: 'deploy\\s+--prod', message: 'Production deploys go through the pipeline.' },
  { id: 'no-edit-vendor', paths: ['vendor/**'], message: 'vendor/ is third-party code; update it with npm run vendor.' },
];
const settingsOf = (dir) => join(dir, '.cartwright', 'settings.json');
const profiled = (dir) => { profileWrite(dir, ...PROFILED); editJson(settingsOf(dir), (s) => { s.rules = RULES; }); };
const personal = (dir, p) => writeFileSync(join(dir, '.cartwright', 'personal.json'), JSON.stringify({ cartwright: 'personal', version: 1, ...p }) + '\n');

// Project setups: `once` runs on the shared template (and is committed and pushed); `each` runs on every copy.
const SETUPS = {
  unprofiled: {},
  profiled: { once: profiled },
  'agents-md': { once: (d) => profileWrite(d, ...PROFILED.map((a) => (a === 'folder' ? 'agents-md' : a))) },
  machine: { each: (d) => profileWrite(d, ...PROFILED.map((a) => (a === 'folder' ? 'machine' : a))) },
  // AGENTS.md as a symlink to CLAUDE.md, with the section in CLAUDE.md.
  'agents-md-link': { once: (d) => { renameSync(join(d, 'AGENTS.md'), join(d, 'CLAUDE.md')); symlinkSync('CLAUDE.md', join(d, 'AGENTS.md')); profileWrite(d, ...PROFILED.map((a) => (a === 'folder' ? 'agents-md' : a))); } },
  broken: { once: (d) => { profiled(d); writeFileSync(settingsOf(d), '{ "cartwright": "settings", "version": 1,\n'); } },
  'switched-off': { once: (d) => { profiled(d); editJson(settingsOf(d), (s) => { s.guardrails['generated-files'] = false; s.guardrails['protected-branches'] = false; }); } },
  'personal-tighten': { once: (d) => { profiled(d); editJson(settingsOf(d), (s) => { s.guardrails['generated-files'] = false; }); personal(d, { guardrails: { 'generated-files': true }, protectedBranches: ['staging'] }); } },
  'personal-loosen': { once: (d) => { profiled(d); personal(d, { guardrails: { secrets: false, 'protected-branches': false }, protectedBranches: [] }); } },
  husky: { once: (d) => { profiled(d); mkdirSync(join(d, '.husky'), { recursive: true }); writeFileSync(join(d, '.husky', 'pre-commit'), '#!/bin/sh\ntouch .husky-ran\n', { mode: 0o755 }); }, each: (d) => git(d, 'config', 'core.hooksPath', '.husky') },
};

// One template per setup per test process; each case gets its own copy of the project and of its remote.
let seq = 0;
const templates = {};
function template(setup) {
  if (templates[setup]) return templates[setup];
  const id = `${setup}-${process.pid}`, src = join(WORK, 'src', id);
  cpSync(join(ROOT, 'tests', 'projects', 'ts'), src, { recursive: true });
  mkdirSync(join(src, 'vault', 'keys'), { recursive: true });
  writeFileSync(join(src, 'vault', 'keys', 'k.txt'), 'not a real key\n');
  git(src, 'init', '-q', '-b', 'main'); git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'fixture'); git(src, 'branch', 'develop');
  const bare = join(WORK, 'remotes', `${id}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(WORK, 'init', '-q', '--bare', '-b', 'main', bare);
  git(src, 'push', '-q', bare, 'main', 'develop');
  const dir = join(WORK, 'templates', id);
  git(WORK, 'clone', '-q', bare, dir);
  if (SETUPS[setup].once) { SETUPS[setup].once(dir); commitPush(dir, setup); }
  return (templates[setup] = { dir, bare });
}
function fresh(setup) {
  const t = template(setup), id = `${setup} ${++seq}-${process.pid}`;
  const dir = join(WORK, 'projects', id), bare = join(WORK, 'remotes', `${id}.git`);
  cpSync(t.bare, bare, { recursive: true, preserveTimestamps: true });
  cpSync(t.dir, dir, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  git(dir, 'remote', 'set-url', 'origin', bare);
  SETUPS[setup].each?.(dir);
  return { dir, bare };
}
const refs = (bare) => sh('git', ['--git-dir', bare, 'for-each-ref', '--format=%(refname) %(objectname)'], { env: env() }).stdout;

// Placeholders in a case, filled in for one project.
const TOKEN = 'gh' + 'p_' + randomBytes(18).toString('hex'), AWS = randomBytes(8).toString('hex').toUpperCase().slice(0, 16);
const fill = (v, dir) => (typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (m, k) => ({ HOME, TMPDIR: TMP, STATE, ALLOWED, OUTSIDE, PROJECT: dir, TOKEN, AWS, PLUGIN, MACHINE: dir && machineDir(dir) }[k] ?? m))
  : Array.isArray(v) ? v.map((x) => fill(x, dir)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, dir)])) : v);

// The tool call in one agent's payload shape (design 5.3; the Copilot and Codex shapes are the spike's).
function payload(agent, c, dir) {
  if (c.payload) return fill(c.payload, dir);
  const at = (p) => resolve(dir, fill(p, dir));
  if (c.shell !== undefined) {
    const command = fill(c.shell, dir);
    if (agent === 'copilot-camel') return { toolName: 'bash', toolArgs: { command }, cwd: dir };
    if (agent === 'codex-exec') return { tool_name: 'exec_command', tool_input: { cmd: ['bash', '-lc', command] }, cwd: dir };
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir };
  }
  if (c.patch !== undefined) return { tool_name: 'apply_patch', tool_input: { command: fill(c.patch, dir) }, cwd: dir };
  if (c.edit) {
    const e = fill(c.edit, dir);
    if (agent === 'copilot') return { tool_name: 'Edit', tool_input: { path: at(e.path), old_str: e.before, new_str: e.after }, cwd: dir };
    if (agent === 'codex') return { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${at(e.path)}\n@@\n-${e.before}\n+${e.after}\n*** End Patch` }, cwd: dir };
    return { tool_name: 'Edit', tool_input: { file_path: at(e.path), old_string: e.before, new_string: e.after }, cwd: dir };
  }
  const w = fill(c.write, dir);
  if (agent === 'copilot') return { tool_name: 'create', tool_input: { path: at(w.path), file_text: w.content }, cwd: dir };
  if (agent === 'codex') return { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Add File: ${at(w.path)}\n${w.content.split('\n').map((l) => `+${l}`).join('\n')}\n*** End Patch` }, cwd: dir };
  return { tool_name: 'Write', tool_input: { file_path: at(w.path), content: w.content }, cwd: dir };
}

// Run one case for one agent: { decision, rule, message, ms }.
function call(c, agent, dir, extraEnv = {}) {
  const log = join(dir, '..', `guard-${seq}-${agent}.log`);
  const e = env({ ...AGENT_ENV[agent], CARTWRIGHT_GUARD_LOG: log, ...extraEnv });
  const p = payload(agent, c, dir);
  const t = process.hrtime.bigint();
  let exit, message;
  if (c.via === 'hook') { const r = sh('/bin/sh', ['-c', HOOK], { cwd: dir, input: JSON.stringify(p), env: e }); exit = r.status; message = r.stderr; }
  else { const r = respond(p, e); exit = r.exit; message = r.stderr || ''; }
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { exit, decision: exit === 2 ? 'deny' : exit === 0 ? 'allow' : `exit ${exit}`, rule: lines.at(-1)?.rule ?? null, logLines: lines.length, message: message || '', ms };
}

function prepare(ops, dir) {
  for (const op of ops || []) {
    const [kind, ...a] = fill(op, dir);
    if (kind === 'git') git(dir, ...a);
    else if (kind === 'write') { const f = resolve(dir, a[0]); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, a[1]); }
    else if (kind === 'append') appendFileSync(join(dir, a[0]), a[1]);
    else if (kind === 'symlink') { const link = resolve(dir, a[1]); mkdirSync(dirname(link), { recursive: true }); rmSync(link, { force: true, recursive: true }); symlinkSync(a[0], link); }
    else if (kind === 'mkdir') mkdirSync(resolve(dir, a[0]), { recursive: true });
  }
}

// Whether this disk ignores letter case (macOS by default): the work folder answers to its upper-cased name.
const CASE_INSENSITIVE = (() => { try { return realpathSync(WORK.toUpperCase()) !== null; } catch { return false; } })();
const CASES = JSON.parse(readFileSync(join(ROOT, 'tests', 'guard-cases.json'), 'utf8')).cases.filter((c) => !opt('--only') || c.name.includes(opt('--only')));
const timings = { plain: [], git: [] };
for (const c of CASES) {
  const agents = c.agents || ['claude-code'];
  step(`${c.name}${c.via === 'hook' ? ' [hook]' : ''} (${agents.join(', ')})`, () => {
    const seen = [];
    if (c.caseInsensitiveOnly && !CASE_INSENSITIVE) return 'skipped: this disk tells letter case apart, so the wrong case is simply another path';
    for (const agent of agents) {
      const { dir, bare } = fresh(c.setup);
      prepare(c.prepare, dir);
      const before = refs(bare);
      const r = call(c, agent, dir);
      const say = `${agent}: ${r.decision}${r.rule ? ` (${r.rule})` : ''}${r.message ? ` "${r.message.trim().slice(0, 140)}"` : ''}`;
      assert(r.decision === c.expect, `${say}; expected ${c.expect}`);
      if (c.rule) assert(r.rule === c.rule, `${say}; expected rule ${c.rule}`);
      if (c.expect === 'deny') assert(r.logLines === 1, `${agent}: ${r.logLines} decision-log lines, expected exactly 1`);
      for (const inc of fill(c.includes || [], dir)) assert(r.message.includes(inc), `${agent}: message lacks "${inc}": ${r.message.trim().slice(0, 300)}`);
      for (const exc of fill(c.excludes || [], dir)) assert(!r.message.includes(exc), `${agent}: message shows "${exc.slice(0, 12)}…"`);
      if (c.run && r.decision === 'allow') {
        const x = sh('/bin/sh', ['-c', fill(c.shell, dir)], { cwd: dir, env: env() });
        assert(x.status === 0, `${agent}: the allowed command failed: ${x.stderr.trim().slice(0, 200)}`);
      }
      if (c.remote === 'unchanged') assert(refs(bare) === before, `${agent}: the remote changed`);
      if (c.remote?.startsWith('has:')) assert(refs(bare).includes(`refs/heads/${c.remote.slice(4)} `), `${agent}: the remote has no ${c.remote.slice(4)}`);
      if (c.committed) assert(git(dir, 'log', '-1', '--format=%s').trim() === c.committed, `${agent}: not committed`);
      if (c.exists) assert(existsSync(join(dir, c.exists)), `${agent}: ${c.exists} missing (the project's hook didn't run)`);
      if (c.via === 'hook') (c.shell && /\bgit\b/.test(c.shell) ? timings.git : timings.plain).push(r.ms);
      seen.push(`${agent} ${r.decision}`);
    }
    return seen.join(', ');
  });
}

step('the hook entry finds the guard through the cached plugin root when no agent variable is set', () => {
  const { dir } = fresh('profiled');
  mkdirSync(STATE, { recursive: true });
  const state = join(WORK, `state-cache-${process.pid}`);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'plugin-root'), PLUGIN);
  const r = sh('/bin/sh', ['-c', HOOK], { cwd: dir, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: dir }), env: env({ CARTWRIGHT_STATE_DIR: state }) });
  assert(r.status === 2 && /protected-branches/.test(r.stderr), `exit ${r.status}: ${r.stderr.trim()}`);
  return 'denied via <state>/plugin-root';
});

step('the hook entry allows everything when node is missing, and when the plugin can\'t be found', () => {
  const { dir } = fresh('profiled');
  // A PATH with a shell but no node.
  const nobin = join(WORK, `no-node-${process.pid}`); mkdirSync(nobin, { recursive: true });
  for (const c of ['sh', 'cat']) symlinkSync(sh('/bin/sh', ['-c', `command -v ${c}`]).stdout.trim(), join(nobin, c));
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: dir });
  const a = sh('/bin/sh', ['-c', HOOK], { cwd: dir, input, env: { ...env({ CLAUDE_PLUGIN_ROOT: PLUGIN }), PATH: nobin } });
  const b = sh('/bin/sh', ['-c', HOOK], { cwd: dir, input, env: env({ CARTWRIGHT_STATE_DIR: join(WORK, 'nowhere') }) });
  assert(a.status === 0 && b.status === 0, `no node: exit ${a.status}; no plugin: exit ${b.status}`);
  return 'exit 0 both times (the session start reports it; milestone 3)';
});

step('a malformed payload or an empty one is allowed, never an error exit', () => {
  const { dir } = fresh('profiled');
  const exits = ['not json', '', '[]', '{"tool_name":"Bash","tool_input":"git push origin main"}'].map((input) => sh('/bin/sh', ['-c', HOOK], { cwd: dir, input, env: env({ CLAUDE_PLUGIN_ROOT: PLUGIN }) }).status);
  assert(exits.slice(0, 3).every((x) => x === 0), `exits: ${exits.join(', ')}`);
  assert(exits[3] === 2, `a string tool_input should still be read as a command (exit ${exits[3]})`);
  return `exits ${exits.join(', ')}`;
});

step('a handled tool whose input has no command or path logs its field names, never their values', () => {
  const { dir } = fresh('profiled');
  const log = join(dir, '..', 'guard-fields.log');
  const e = env({ COPILOT_PLUGIN_ROOT: PLUGIN, CARTWRIGHT_GUARD_LOG: log });
  const edit = respond({ toolName: 'Edit', toolArgs: { target_file: 'secret-value-1', old_str: 'secret-value-2', new_str: 'secret-value-3' }, cwd: dir }, e);
  const bash = respond({ toolName: 'bash', toolArgs: { script: 'secret-value-4' }, cwd: dir }, e);
  const ok = respond({ toolName: 'bash', toolArgs: { command: 'git status' }, cwd: dir }, e);
  const text = readFileSync(log, 'utf8');
  const lines = text.trim().split('\n').map((l) => JSON.parse(l));
  assert(edit.exit === 2 && bash.exit === 0 && ok.exit === 0, `decisions: edit ${edit.exit}, bash ${bash.exit}, ok ${ok.exit}`);
  assert(lines.length === 3, `${lines.length} log lines, expected 3`);
  assert(JSON.stringify(lines[0].fields) === '["new_str","old_str","target_file"]' && lines[0].decision === 'deny', `edit line: ${JSON.stringify(lines[0])}`);
  assert(JSON.stringify(lines[1].fields) === '["script"]' && lines[1].rule === null && lines[1].decision === 'allow', `bash line: ${JSON.stringify(lines[1])}`);
  assert(lines[2].fields === undefined, `a readable input listed fields: ${JSON.stringify(lines[2])}`);
  assert(!/secret-value/.test(text), 'a value reached the log');
  return 'Edit without a path: denied, field names logged; bash without a command: allowed, field names logged; no values';
});

step('Cartwright\'s own settings (F47, F48): INDEX.md and pushes to develop are blocked here; npm run build isn\'t', () => {
  // In-process, against this repository itself (read-only): its committed .cartwright/ settings.
  const e = env({ CLAUDE_PLUGIN_ROOT: PLUGIN });
  const run = (p) => respond({ ...p, cwd: ROOT }, e);
  const index = run({ tool_name: 'Edit', tool_input: { file_path: join(ROOT, 'INDEX.md'), old_string: 'Skill index', new_string: 'Skills' } });
  const push = run({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:develop' } });
  const plugin = run({ tool_name: 'Bash', tool_input: { command: 'echo x >> plugin/tools/setup.mjs' } });
  const build = run({ tool_name: 'Bash', tool_input: { command: 'npm run build && git push -u origin feature/x' } });
  assert(index.exit === 2 && /INDEX\.md is generated.*run npm run build/.test(index.stderr), `INDEX.md edit: ${index.stderr || index.exit}`);
  assert(push.exit === 2 && /push to develop, a protected branch/.test(push.stderr), `push to develop: ${push.stderr || push.exit}`);
  assert(plugin.exit === 2 && /plugin\/tools\/setup\.mjs is generated/.test(plugin.stderr), `shell write into plugin/: ${plugin.stderr || plugin.exit}`);
  assert(build.exit === 0, `npm run build and a feature push: ${build.stderr}`);
  return 'INDEX.md edit, a write into plugin/ and a push to develop blocked; npm run build and a feature push allowed';
});

step('failing safe (5.7): a rule that fails denies only actions in its family; an expired deadline denies "couldn\'t finish in time"', () => {
  const { dir } = fresh('profiled');
  const e = env({ CLAUDE_PLUGIN_ROOT: PLUGIN });
  const run = (command, patch = {}, ctxOpts = {}) => {
    const action = normalise({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, e);
    const ctx = { ...makeContext({ cwd: dir, env: e, ...ctxOpts }), ...patch };
    return decide(action, ctx);
  };
  const boom = { agentsSection: () => { throw new Error('boom'); }, pushDestination: () => { throw new Error('boom'); } };
  const outside = run('ls -la && git status', boom);
  assert(outside.decision === 'allow', `an action outside the failing rules' families: ${outside.decision} ${outside.message || ''}`);
  const write = run('echo x > notes.txt', boom);
  assert(write.decision === 'deny' && /couldn't check this safely \(guardrail-files\) \(boom\)/.test(write.message), `a write while guardrail-files fails: ${write.decision} ${write.message || ''}`);
  const push = run('git push', boom);
  assert(push.decision === 'deny' && /couldn't check this safely \(protected-branches\) \(boom\)/.test(push.message), `a push while its rule fails: ${push.message || push.decision}`);
  prepare([['write', 'big.txt', 'x\n'], ['git', 'add', 'big.txt']], dir);
  const late = run('git commit -m big', {}, { deadline: Date.now() - 1 });
  assert(late.decision === 'deny' && /couldn't finish checking this in time \(a busy machine or a large commit\): try again, or commit in smaller parts/.test(late.message), `an expired deadline: ${late.message || late.decision}`);
  return 'unrelated action allowed; write and push denied with the error; deadline → "couldn\'t finish checking this in time"';
});

step('timing (5.9): the guard\'s overhead above starting node, through the hook', () => {
  const { dir } = fresh('profiled');
  const plain = { via: 'hook', edit: { path: 'src/server.ts', before: 'ok: true', after: 'ok: false' } };
  const push = { via: 'hook', shell: 'git push origin main' };
  const p = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
  // The machine's own cost of starting node through sh, sampled in turn with the guard, so background load affects
  // both alike and what's judged is what the guard adds. Each timed call must really have been decided.
  const nodeAlone = () => { const t = process.hrtime.bigint(); sh('/bin/sh', ['-c', `exec "${NODE}" -e 0`], { cwd: dir, env: env() }); return Number(process.hrtime.bigint() - t) / 1e6; };
  const timed = (c, want) => { const r = call(c, 'claude-code', dir); assert(r.decision === want && r.logLines >= 1, `a timed call wasn't decided: ${r.decision}`); return r.ms; };
  // Judged on the median of paired differences (guard_i - node_i, sampled in turn), so one stall can't fail it.
  const bare = [], a = [], b = [];
  for (let i = 0; i < 30; i++) { bare.push(nodeAlone()); a.push(timed(plain, 'allow')); b.push(timed(push, 'deny')); }
  const median = (xs) => p(xs, 0.5);
  const addA = median(a.map((x, i) => x - bare[i])), addB = median(b.map((x, i) => x - bare[i]));
  // Budgets for what the guard adds: 100 ms without git, 400 ms for a push; the test fails beyond twice that.
  const line = `node alone: p50 ${p(bare, 0.5).toFixed(0)} ms, p95 ${p(bare, 0.95).toFixed(0)} ms; no git: p50 ${p(a, 0.5).toFixed(0)} ms, p95 ${p(a, 0.95).toFixed(0)} ms (adds ${addA.toFixed(0)}, budget 100); push: p50 ${p(b, 0.5).toFixed(0)} ms, p95 ${p(b, 0.95).toFixed(0)} ms (adds ${addB.toFixed(0)}, budget 400); median of 30 paired differences`;
  assert(addA <= 200 && addB <= 800, `the guard adds more than twice its budget: ${line}`);
  return line;
}, { alone: true, timing: true });

process.exit(await report('Cartwright guard test', { keep: KEEP }));
