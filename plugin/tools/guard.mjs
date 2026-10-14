#!/usr/bin/env node
// Cartwright's guardrail hook. Claude Code, Codex and GitHub Copilot call it before a write-capable tool runs (the
// PreToolUse entry in hooks/hooks.json); it reads the tool call on stdin, turns each agent's payload into the same
// actions, asks guard-rules.mjs for a decision, and answers the way all three agents understand: exit 0 to allow, exit 2
// with the reason on stderr to deny. It never exits with anything else and never hangs (an internal 5 s deadline).
// Shipped in the plugin as tools/guard.mjs. No dependencies: Node and git only.
//
//   node guard.mjs pre-tool-use          the hook: the agent's tool call as JSON on stdin
//   node guard.mjs explain "<command>"   JSON: what the guard would decide for a shell command here, and why
//   node guard.mjs status                JSON: whether the guard runs here, the project's settings and rules
// Options: --dir <path> for explain and status. CARTWRIGHT_GUARD_LOG=<file> appends one line per decision (no
// command text and no paths, so no secrets). When a handled tool's input has no command or path, the line also lists
// the input's field names (never their values).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmAsDeny, confirmReason, decide, prepare, projectsOf, READINGS, RULES, ruleSettings } from './guard-rules.mjs';
import { shQuote } from './guard-shell.mjs';
import { resolveSettings } from './settings.mjs';
import { agentsFile, load, machineDir, readSection, stateDir } from './store.mjs';

export const DEADLINE_MS = 5000;
// Agents whose own approval prompt ("ask") is verified to work for a hook. Elsewhere a guardrail-file change is denied
// with the command for the person to run (G4). Claude Code's was verified by hand on 2026-10-14 (Claude Code 2.1.296: its
// approval prompt showed Cartwright's reason, and No left the settings unchanged). A headless session (claude -p)
// refuses an ask instead of waiting, so nothing changes there either.
export const ASK_VERIFIED = { 'claude-code': true, copilot: false, codex: false, vscode: false };
// Tool names by what they do, from every agent's payloads. VS Code's (GitHub Copilot Chat agent mode) come from the
// built-in Copilot extension (copilot-chat 0.69.0 in VS Code 1.141): its ToolName table in dist/extension.js and the
// input schemas in package.json (contributes.languageModelTools); run_in_terminal, send_to_terminal and
// create_and_run_task are VS Code core tools (schemas in out/vs/workbench/workbench.desktop.main.js).
// Copilot CLI 1.0.96 (cli-main.js and prebuilds/darwin-arm64/runtime.node in its package): bash, powershell and
// local_shell run commands; write_bash and write_powershell type input into a running one; create, edit, str_replace,
// str_replace_editor and apply_patch change files. Codex 0.162.1 (core/src/tools/handlers in its binary):
// exec_command runs a command, write_stdin types `chars` into a running one, apply_patch changes files.
const SHELL_TOOLS = ['bash', 'shell', 'powershell', 'local_shell', 'shell_command', 'exec_command', 'run_in_terminal', 'send_to_terminal'];
// Tools that type text into a shell that's already running: the text is read as a command, from the session's folder.
const STDIN_TOOLS = { write_stdin: 'chars', write_bash: 'input', write_powershell: 'input' };
const EDIT_TOOLS = ['edit', 'str_replace', 'write', 'multiedit', 'notebookedit', 'create', 'apply_patch', 'create_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'insert_edit_into_file', 'edit_notebook_file', 'create_directory'];
export const VSCODE_TOOLS = ['run_in_terminal', 'send_to_terminal', 'create_and_run_task', 'run_vscode_command', 'create_file', 'replace_string_in_file', 'multi_replace_string_in_file', 'insert_edit_into_file', 'edit_notebook_file', 'create_directory', 'read_file', 'list_dir'];
// VS Code commands that push the current branch (run_vscode_command), as the push each one makes.
const VSCODE_PUSH = { 'git.push': 'git push', 'git.pushTo': 'git push', 'git.sync': 'git push', 'git.pushForce': 'git push --force', 'git.pushWithTags': 'git push --follow-tags', 'git.publish': 'git push -u origin HEAD' };
const SELF = fileURLToPath(import.meta.url);
const PLUGIN = dirname(dirname(SELF));

// --- payloads -----------------------------------------------------------------------------------------------------
// Which agent sent this: Copilot (its variables, or its camelCase payload), Codex (PLUGIN_ROOT without Copilot's, or a
// Codex-only tool), else Claude Code.
// The label only sets the log's agent and whether "ask" is used: the payload's own shape decides how it's read.
// Order: a Copilot variable or payload → copilot; PLUGIN_ROOT → codex; VS Code's tool names or patch shape, or VS Code's
// variables without Claude Code's own CLAUDECODE marker (Claude Code and Codex started in VS Code's terminal inherit
// VSCODE_*) → vscode; Codex-only tools → codex; else claude-code.
export function agentOf(p, env) {
  if (p.toolName !== undefined || env.COPILOT_PLUGIN_ROOT || env.COPILOT_CLI) return 'copilot';
  if (env.PLUGIN_ROOT) return 'codex';
  const tool = String(p.tool_name || '').toLowerCase();
  if (VSCODE_TOOLS.includes(tool) || (tool === 'apply_patch' && typeof p.tool_input?.input === 'string') || ((env.VSCODE_PID || env.VSCODE_IPC_HOOK) && !env.CLAUDECODE)) return 'vscode';
  if (/^(apply_patch|exec_command|write_stdin)$/.test(tool)) return 'codex';
  return 'claude-code';
}

// Any agent's PreToolUse payload as { agent, tool, cwd, actions: [{ type: 'shell', command } | { type: 'edit', targets }] }.
// Unknown tools give no actions (allowed). An edit tool with no path gives a target with path null (checked strictly).
export function normalise(p, env = process.env) {
  if (!p || typeof p !== 'object') return null;
  const tool = String(p.tool_name ?? p.toolName ?? '');
  let input = p.tool_input ?? p.toolArgs ?? {};
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = { command: input }; } }
  if (!input || typeof input !== 'object') input = {};
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : env.CLAUDE_PROJECT_DIR || env.COPILOT_PROJECT_DIR || process.cwd();
  const t = tool.toLowerCase(), actions = [];
  const str = (...v) => v.find((x) => typeof x === 'string');
  let missed = false;
  if (t in STDIN_TOOLS) {
    const text = str(input[STDIN_TOOLS[t]]);
    if (text !== undefined) { if (text.trim()) actions.push({ type: 'shell', command: text.replace(/\r/g, '') }); } else missed = true;
  } else if (t === 'run_vscode_command') {
    // VS Code's own commands: its git push commands push the current branch; sendSequence types text into the terminal.
    const id = str(input.commandId);
    if (id === undefined) missed = true;
    else if (VSCODE_PUSH[id]) actions.push({ type: 'shell', command: VSCODE_PUSH[id] });
    else if (id === 'workbench.action.terminal.sendSequence') {
      const a = Array.isArray(input.args) ? input.args[0] : input.args;
      const text = str(a?.text, typeof a === 'string' ? a : undefined);
      if (text !== undefined && text.trim()) actions.push({ type: 'shell', command: text.replace(/\r/g, '\n') });
    }
  } else if (t === 'str_replace_editor') {
    // Copilot's editor tool: { command: view | create | str_replace | insert, path, file_text, old_str, new_str }.
    const path = str(input.path, input.file_path) ?? null;
    const sub = str(input.command);
    if (sub === 'create') actions.push({ type: 'edit', targets: [{ path, op: 'write', content: str(input.file_text) ?? '' }] });
    else if (sub === 'str_replace') actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: [{ before: str(input.old_str) ?? '', after: str(input.new_str) ?? '' }] }] });
    else if (sub === 'insert') actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: [{ before: '', after: str(input.new_str) ?? '' }] }] });
    if (sub !== 'view' && path === null) missed = true;
  } else if (t === 'create_and_run_task') {
    // VS Code's task: { task: { label, type, command, args } } runs command with args in a shell.
    const task = input.task && typeof input.task === 'object' ? input.task : input;
    const args = Array.isArray(task.args) ? task.args.map((x) => shQuote(String(x))).join(' ') : '';
    if (typeof task.command === 'string') actions.push({ type: 'shell', command: `${task.command}${args ? ` ${args}` : ''}` }); else missed = true;
  } else if (SHELL_TOOLS.includes(t)) {
    const c = input.command ?? input.cmd;
    const command = Array.isArray(c) ? c.map((x) => shQuote(String(x))).join(' ') : str(c);
    if (command !== undefined) actions.push({ type: 'shell', command }); else missed = true;
  } else if (t === 'apply_patch') {
    const c = input.command ?? input.input ?? input.patch;
    const text = Array.isArray(c) ? c.find((x) => typeof x === 'string' && x.includes('*** Begin Patch')) ?? c.join('\n') : str(c);
    if (text === undefined) missed = true;
    // Read as a shell apply_patch with the patch as a here-document, so shell and tool patches share one reader.
    actions.push({ type: 'shell', command: `apply_patch <<'CARTWRIGHT_PATCH'\n${text ?? ''}\nCARTWRIGHT_PATCH`, tool: 'apply_patch' });
  } else if (t === 'multi_replace_string_in_file') {
    // VS Code: { replacements: [{ filePath, oldString, newString }] }, one target per replacement.
    const reps = Array.isArray(input.replacements) ? input.replacements : [];
    if (!reps.length) { missed = true; actions.push({ type: 'edit', targets: [{ path: null, op: 'modify', edits: [] }] }); }
    for (const r of reps) actions.push({ type: 'edit', targets: [{ path: str(r?.filePath, r?.file_path) ?? null, op: 'modify', edits: [{ before: str(r?.oldString) ?? '', after: str(r?.newString) ?? '' }] }] });
  } else if (EDIT_TOOLS.includes(t)) {
    const path = str(input.file_path, input.path, input.filePath, input.notebook_path, input.dirPath) ?? null;
    if (path === null) missed = true;
    if (t === 'multiedit') actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: (Array.isArray(input.edits) ? input.edits : []).map((e) => ({ before: e.old_string ?? e.old_str ?? '', after: e.new_string ?? e.new_str ?? '' })) }] });
    else if (t === 'write' || t === 'create' || t === 'create_file') actions.push({ type: 'edit', targets: [{ path, op: 'write', content: str(input.content, input.file_text, input.new_str) ?? '' }] });
    else if (t === 'create_directory') actions.push({ type: 'edit', targets: [{ path, op: 'write', content: '' }] });
    // VS Code's insert_edit_into_file gives code with "existing code" markers, not an exact change: judged as touching
    // anything in the file; edit_notebook_file likewise.
    else if (t === 'insert_edit_into_file' || t === 'edit_notebook_file') actions.push({ type: 'edit', targets: [{ path, op: 'modify' }] });
    else if (t === 'replace_string_in_file') actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: [{ before: str(input.oldString) ?? '', after: str(input.newString) ?? '' }] }] });
    else if (t === 'notebookedit') actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: [{ before: '', after: str(input.new_source) ?? '' }] }] });
    else actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: [{ before: str(input.old_string, input.old_str) ?? '', after: str(input.new_string, input.new_str) ?? '' }] }] });
  }
  // A tool the guard handles whose input gave no command or path: its field names (never values), for the log.
  const fields = missed ? Object.keys(input).slice(0, 20).map((k) => k.slice(0, 40)).sort() : undefined;
  return { agent: agentOf(p, env), tool, cwd, actions, ...(fields ? { fields } : {}) };
}

// --- the machine, as the rules see it ----------------------------------------------------------------------------
class Deadline extends Error { constructor() { super('the check ran out of time'); this.deadline = true; } }

// root: judge this project (of several the action touches) instead of the one cwd is in; only that project's commands
// and edits are judged then (ctx.only).
export function makeContext({ cwd, env = process.env, deadline = Date.now() + DEADLINE_MS, root: forcedRoot = null, cwdRoot = null }) {
  const memo = (f) => { let done = false, v; return () => { if (!done) { v = f(); done = true; } return v; }; };
  const tick = () => { if (Date.now() > deadline) throw new Deadline(); };
  // Real paths come from realpath(3) (realpathSync.native), which also gives the on-disk letter case, so GEN/api.ts
  // can't pass for gen/api.ts on a case-insensitive disk.
  const native = (p) => realpathSync.native(p);
  const listings = new Map();
  // The final name in the folder's own letter case, when it exists under another case.
  const caseOf = (dir, name) => {
    try { lstatSync(join(dir, name)); } catch { return name; }
    if (!listings.has(dir)) { try { listings.set(dir, readdirSync(dir)); } catch { listings.set(dir, []); } }
    const names = listings.get(dir);
    return names.includes(name) ? name : names.find((n) => n.toLowerCase() === name.toLowerCase()) || name;
  };
  // A path with its folders' symlinks resolved and the final name kept as given (so "rm link" judges the link).
  const realish = (p) => {
    const abs = resolve(p);
    if (abs === sep) return abs;
    let dir = dirname(abs), rest = [];
    while (true) {
      try { const d = native(dir); const parts = [...rest, abs.slice(abs.lastIndexOf(sep) + 1)]; return join(d, ...(parts.length === 1 ? [caseOf(d, parts[0])] : parts)); }
      catch { if (dir === dirname(dir)) return abs; rest.unshift(dir.slice(dir.lastIndexOf(sep) + 1)); dir = dirname(dir); }
    }
  };
  // A path through every symlink, the final one included: for writes onto it, and paths that go through it.
  const realFull = (p) => { try { return native(p); } catch { return realish(p); } };
  const here = memo(() => { try { return native(cwd); } catch { return resolve(cwd); } });
  const git = (dir, ...args) => {
    tick();
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 64 * 1024 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    if (r.error?.code === 'ETIMEDOUT') throw new Deadline();
    return r.status === 0 ? r.stdout : null;
  };
  // The project: the nearest folder with .git, found without running git; else the folder itself.
  const root = memo(() => forcedRoot || (() => { for (let d = here(); ; d = dirname(d)) { if (existsSync(join(d, '.git'))) return d; if (d === dirname(d)) return here(); } })());
  // The project a path belongs to (the nearest folder with .git), or null when it's in none.
  const roots = new Map();
  const rootOf = (p) => {
    if (!p) return null;
    if (roots.has(p)) return roots.get(p);
    let found = null;
    try { for (let d = realish(p); ; d = dirname(d)) { if (existsSync(join(d, '.git'))) { found = d; break; } if (d === dirname(d)) break; } } catch { /* none */ }
    roots.set(p, found);
    return found;
  };
  const stored = memo(() => load(root()));
  const settings = memo(() => {
    const st = stored();
    const profile = st.profile.status === 'ok' ? st.profile.data : null;
    return ruleSettings(resolveSettings({ team: st.settings, personal: st.personal, profile }), st.settings.file);
  });
  const expand = (loc) => {
    let t = String(loc).replace(/^~(?=\/|$)/, env.HOME || '~');
    let unknown = false;
    t = t.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, a, b) => { const v = env[a || b]; if (v === undefined) unknown = true; return v ?? ''; });
    if (unknown || t.startsWith('~')) return null;
    return realish(isAbsolute(t) ? t : resolve(root(), t));
  };
  const real = (p) => { try { return native(p); } catch { return null; } };
  const locations = memo(() => {
    const s = settings();
    const temp = [env.TMPDIR, env.TMP, env.TEMP, ...READINGS.systemTemp].filter(Boolean).map(real).filter(Boolean);
    const cache = [stateDir(), ...READINGS.pluginData.map((k) => env[k])].filter(Boolean).map((p) => real(p) || realish(p));
    return { temp, cache, allowed: s.allowed.map(expand).filter(Boolean), protected: s.protected.map(expand).filter(Boolean) };
  });
  return {
    env, tick, realish, realFull, git, root, settings, stored, rootOf,
    // Judging one project of several: an item belongs to it when one of its projects is this one (paths in no project
    // belong to the action's own project).
    only: forcedRoot ? (rs) => rs.some((r) => (r ?? cwdRoot) === forcedRoot) : null,
    cwd: here,
    stateDir: () => real(stateDir()) || realish(stateDir()),
    // The plugin this guard runs from: its own tools are Cartwright's sanctioned writers, not agent scripts.
    pluginRoot: () => real(PLUGIN) || PLUGIN,
    // This project's folder in the machine-only store.
    machineDir: memo(() => { try { const d = machineDir(root()); return real(d) || realish(d); } catch { return null; } }),
    locations: () => locations(),
    exists: (p) => { try { statSync(p); return true; } catch { return false; } },
    isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
    readText: (p, max = 1024 * 1024) => { try { return statSync(p).size > max ? null : readFileSync(p, 'utf8'); } catch { return null; } },
    gitAlias: (dir, name) => (git(dir, 'config', '--get', `alias.${name}`) || '').trim() || null,
    gitConfigAll: (dir, key) => { const t = git(dir, 'config', '--get-all', key); return t === null ? null : t.split('\n').filter(Boolean); },
    gitTop: (dir) => (git(dir, 'rev-parse', '--show-toplevel') || '').trim() || dir,
    currentBranch: (dir) => (git(dir, 'symbolic-ref', '--short', '-q', 'HEAD') || '').trim() || null,
    // Where git says a bare push goes, with the invocation's configuration changes (-c) applied.
    pushDestination: (dir, configArgs = []) => {
      const p = (git(dir, ...configArgs, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}') || '').trim();
      return p ? p.slice(p.indexOf('/') + 1) : (git(dir, 'symbolic-ref', '--short', '-q', 'HEAD') || '').trim() || null;
    },
    localBranches: (dir) => { const t = git(dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'); return t === null ? null : t.split('\n').filter(Boolean); },
    isTagOnly: (dir, name) => git(dir, 'show-ref', '--verify', '-q', `refs/tags/${name}`) !== null && git(dir, 'show-ref', '--verify', '-q', `refs/heads/${name}`) === null,
    // The AGENTS.md section, when the project has one: { path, text, start, end }.
    agentsSection: memo(() => {
      const a = agentsFile(root());
      if (!a.path) return null;
      const text = (() => { try { return readFileSync(a.path, 'utf8'); } catch { return null; } })();
      if (text === null) return null;
      const sec = readSection(text);
      // path keeps a symlink's own name (AGENTS.md → CLAUDE.md); real is the file it points at, which writes resolve to.
      return sec.status === 'ok' ? { path: realish(a.path), real: realFull(a.path), text, start: sec.start, end: sec.end } : null;
    }),
  };
}

// --- answering the agent ------------------------------------------------------------------------------------------
function log(env, entry) {
  if (!env.CARTWRIGHT_GUARD_LOG) return;
  try { appendFileSync(env.CARTWRIGHT_GUARD_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch { /* logging is optional */ }
}

// Decide for every project the action touches, each by its own settings: the strictest result wins (deny, then
// confirm, then allow). One project, the usual case, is a single decision as before. Returns { r, ctx }.
export function decideAll(action, env = process.env) {
  const deadline = Date.now() + DEADLINE_MS;
  const base = makeContext({ cwd: action.cwd, env, deadline });
  const roots = projectsOf(action, base);
  if (roots.size === 1 && roots.has(base.root())) return { r: decide(action, base), ctx: base };
  let best = null;
  for (const root of roots) {
    const ctx = makeContext({ cwd: action.cwd, env, deadline, root, cwdRoot: base.root() });
    const r = decide(action, ctx);
    if (r.decision === 'deny') return { r, ctx };
    if (r.decision === 'confirm' && (!best || best.r.decision !== 'confirm')) best = { r, ctx };
    best ||= { r, ctx };
  }
  return best;
}

// The decision for a payload, rendered: { exit, stdout, stderr, decision, rule }.
export function respond(payload, env = process.env) {
  const action = normalise(payload, env);
  if (!action || !action.actions.length) {
    // Logged only when a handled tool's input couldn't be read, so the next run shows the payload's shape.
    if (action?.fields) log(env, { agent: action.agent, tool: action.tool, rule: null, decision: 'allow', fields: action.fields, note: 'no command or path found in the tool input' });
    return { exit: 0, decision: 'allow', rule: null };
  }
  const { r, ctx } = decideAll(action, env);
  const settings = ctx.settings().status;
  log(env, { agent: action.agent, tool: action.tool, rule: r.rule, decision: r.decision === 'confirm' && !ASK_VERIFIED[action.agent] ? 'deny' : r.decision, settings, ...(action.fields ? { fields: action.fields, note: 'no command or path found in the tool input' } : {}) });
  if (r.decision === 'deny') return { exit: 2, stderr: r.message, decision: 'deny', rule: r.rule };
  if (r.decision === 'confirm') {
    if (ASK_VERIFIED[action.agent]) return { exit: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: confirmReason(r) } }), decision: 'confirm', rule: r.rule };
    // Only a real shell command is offered for the person to run; an edit tool's change is theirs to make.
    const command = action.actions.find((a) => a.type === 'shell' && !a.tool)?.command;
    return { exit: 2, stderr: confirmAsDeny(r, { command, store: ctx.stored().mode, plugin: PLUGIN }), decision: 'deny', rule: r.rule };
  }
  return { exit: 0, stderr: r.note, decision: 'allow', rule: null };
}

function preToolUse() {
  // Windows: a documented gap. Exit at once and silently; the session start says it once.
  if (process.platform === 'win32') process.exit(0);
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const out = respond(payload);
  if (out.stdout) process.stdout.write(out.stdout + '\n');
  if (out.stderr) process.stderr.write(out.stderr + '\n');
  process.exit(out.exit === 2 ? 2 : 0);
}

function cli(argv) {
  const [cmd, ...rest] = argv;
  const opt = (f) => { const i = rest.indexOf(f); return i > -1 ? rest[i + 1] : undefined; };
  const dir = resolve(opt('--dir') || process.cwd());
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  if (cmd === 'pre-tool-use') return preToolUse();
  if (cmd === 'explain') {
    const command = rest.filter((a, i) => a !== '--dir' && rest[i - 1] !== '--dir').join(' ');
    if (!command) { console.error('guard: give the command to explain, in quotes'); process.exit(2); }
    const action = { agent: 'explain', tool: 'Bash', cwd: dir, actions: [{ type: 'shell', command }] };
    const { r, ctx } = decideAll(action);
    const message = r.decision === 'confirm' ? confirmAsDeny(r, { command, store: ctx.stored().mode, plugin: PLUGIN }) : r.message || null;
    out({ decision: r.decision, rule: r.rule, message, commands: prepare(action, ctx).cmds.map((c) => c.text), settings: ctx.settings().status });
    return;
  }
  if (cmd === 'status') {
    const ctx = makeContext({ cwd: dir });
    const s = ctx.settings();
    const on = (rule) => (RULES[rule].scope === 'profiled' && s.status === 'none') || (RULES[rule].scope === 'valid' && s.status !== 'ok') ? false : !RULES[rule].switchable || s.guardrails[rule] !== false;
    out({ platform: process.platform, active: process.platform !== 'win32', projectRoot: ctx.root(), store: ctx.stored().mode, settings: s.status, message: s.message,
      rules: Object.fromEntries(Object.keys(RULES).map((r) => [r, on(r)])), protectedBranches: s.status === 'none' ? [] : s.protectedBranches, generated: s.generated,
      askVerified: ASK_VERIFIED, log: !!process.env.CARTWRIGHT_GUARD_LOG });
    return;
  }
  console.error('usage: guard.mjs pre-tool-use | explain "<command>" [--dir <path>] | status [--dir <path>]');
  process.exit(2);
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(SELF); } catch { return false; } })();
if (isMain) {
  // Never anything but 0 or 2, whatever happens: Copilot fails closed on other exits.
  process.on('uncaughtException', (e) => { try { process.stderr.write(`Cartwright's guard failed (${e.message}); the action was allowed. Please report it.\n`); } catch { /* nothing more to do */ } process.exit(0); });
  cli(process.argv.slice(2));
}
