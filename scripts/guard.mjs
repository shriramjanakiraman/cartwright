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
// command text and no paths, so no secrets).
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmAsDeny, confirmReason, decide, prepare, READINGS, RULES, ruleSettings } from './guard-rules.mjs';
import { shQuote } from './guard-shell.mjs';
import { resolveSettings } from './settings.mjs';
import { agentsFile, load, readSection, stateDir } from './store.mjs';

export const DEADLINE_MS = 5000;
// Agents whose own approval prompt ("ask") is verified to work for a hook. Until it is, a guardrail-file change is
// denied with the command for the person to run (G4). Claude Code's ask is implemented but not yet verified.
export const ASK_VERIFIED = { 'claude-code': false, copilot: false, codex: false };
const SHELL_TOOLS = ['bash', 'shell', 'exec_command'];
const EDIT_TOOLS = ['edit', 'write', 'multiedit', 'notebookedit', 'create', 'apply_patch'];
const SELF = fileURLToPath(import.meta.url);
const PLUGIN = dirname(dirname(SELF));

// --- payloads -----------------------------------------------------------------------------------------------------
// Which agent sent this: Copilot (its variables, or its camelCase payload), Codex (PLUGIN_ROOT without Copilot's, or a
// Codex-only tool), else Claude Code.
export function agentOf(p, env) {
  if (p.toolName !== undefined || env.COPILOT_PLUGIN_ROOT || env.COPILOT_CLI) return 'copilot';
  if (/^(apply_patch|exec_command)$/i.test(p.tool_name || '') || env.PLUGIN_ROOT) return 'codex';
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
  if (SHELL_TOOLS.includes(t)) {
    const c = input.command ?? input.cmd;
    const command = Array.isArray(c) ? c.map((x) => shQuote(String(x))).join(' ') : str(c);
    if (command !== undefined) actions.push({ type: 'shell', command });
  } else if (t === 'apply_patch') {
    const c = input.command ?? input.input ?? input.patch;
    const text = Array.isArray(c) ? c.find((x) => typeof x === 'string' && x.includes('*** Begin Patch')) ?? c.join('\n') : str(c);
    // Read as a shell apply_patch with the patch as a here-document, so shell and tool patches share one reader.
    actions.push({ type: 'shell', command: `apply_patch <<'CARTWRIGHT_PATCH'\n${text ?? ''}\nCARTWRIGHT_PATCH`, tool: 'apply_patch' });
  } else if (EDIT_TOOLS.includes(t)) {
    const path = str(input.file_path, input.path, input.filePath, input.notebook_path) ?? null;
    if (t === 'multiedit') actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: (Array.isArray(input.edits) ? input.edits : []).map((e) => ({ before: e.old_string ?? e.old_str ?? '', after: e.new_string ?? e.new_str ?? '' })) }] });
    else if (t === 'write' || t === 'create') actions.push({ type: 'edit', targets: [{ path, op: 'write', content: str(input.content, input.file_text, input.new_str) ?? '' }] });
    else if (t === 'notebookedit') actions.push({ type: 'edit', targets: [{ path, op: input.edit_mode === 'delete' ? 'modify' : 'modify', edits: [{ before: '', after: str(input.new_source) ?? '' }] }] });
    else actions.push({ type: 'edit', targets: [{ path, op: 'modify', edits: [{ before: str(input.old_string, input.old_str) ?? '', after: str(input.new_string, input.new_str) ?? '' }] }] });
  }
  return { agent: agentOf(p, env), tool, cwd, actions };
}

// --- the machine, as the rules see it ----------------------------------------------------------------------------
class Deadline extends Error { constructor() { super('the check ran out of time'); this.deadline = true; } }

export function makeContext({ cwd, env = process.env, deadline = Date.now() + DEADLINE_MS }) {
  const memo = (f) => { let done = false, v; return () => { if (!done) { v = f(); done = true; } return v; }; };
  const tick = () => { if (Date.now() > deadline) throw new Deadline(); };
  // A path with its folders' symlinks resolved and the final name kept as given (so "rm link" isn't the target).
  const realish = (p) => {
    const abs = resolve(p);
    if (abs === sep) return abs;
    let dir = dirname(abs), rest = [];
    while (true) { try { return join(realpathSync(dir), ...rest, abs.slice(abs.lastIndexOf(sep) + 1)); } catch { if (dir === dirname(dir)) return abs; rest.unshift(dir.slice(dir.lastIndexOf(sep) + 1)); dir = dirname(dir); } }
  };
  const here = memo(() => { try { return realpathSync(cwd); } catch { return resolve(cwd); } });
  const git = (dir, ...args) => {
    tick();
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 64 * 1024 * 1024, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    if (r.error?.code === 'ETIMEDOUT') throw new Deadline();
    return r.status === 0 ? r.stdout : null;
  };
  // The project: the nearest folder with .git, found without running git; else the folder itself.
  const root = memo(() => { for (let d = here(); ; d = dirname(d)) { if (existsSync(join(d, '.git'))) return d; if (d === dirname(d)) return here(); } });
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
  const real = (p) => { try { return realpathSync(p); } catch { return null; } };
  const locations = memo(() => {
    const s = settings();
    const temp = [env.TMPDIR, env.TMP, env.TEMP, ...READINGS.systemTemp].filter(Boolean).map(real).filter(Boolean);
    const cache = [stateDir(), ...READINGS.pluginData.map((k) => env[k])].filter(Boolean).map((p) => real(p) || realish(p));
    return { temp, cache, allowed: s.allowed.map(expand).filter(Boolean), protected: s.protected.map(expand).filter(Boolean) };
  });
  return {
    env, tick, realish, git, root, settings, stored,
    cwd: here,
    stateDir: () => real(stateDir()) || realish(stateDir()),
    locations: () => locations(),
    exists: (p) => { try { statSync(p); return true; } catch { return false; } },
    isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
    readText: (p, max = 1024 * 1024) => { try { return statSync(p).size > max ? null : readFileSync(p, 'utf8'); } catch { return null; } },
    gitAlias: (dir, name) => (git(dir, 'config', '--get', `alias.${name}`) || '').trim() || null,
    gitTop: (dir) => (git(dir, 'rev-parse', '--show-toplevel') || '').trim() || dir,
    currentBranch: (dir) => (git(dir, 'symbolic-ref', '--short', '-q', 'HEAD') || '').trim() || null,
    pushDestination: (dir) => {
      const p = (git(dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}') || '').trim();
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
      return sec.status === 'ok' ? { path: realish(a.path), text, start: sec.start, end: sec.end } : null;
    }),
  };
}

// --- answering the agent ------------------------------------------------------------------------------------------
function log(env, entry) {
  if (!env.CARTWRIGHT_GUARD_LOG) return;
  try { appendFileSync(env.CARTWRIGHT_GUARD_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch { /* logging is optional */ }
}

// The decision for a payload, rendered: { exit, stdout, stderr, decision, rule }.
export function respond(payload, env = process.env) {
  const action = normalise(payload, env);
  if (!action || !action.actions.length) return { exit: 0, decision: 'allow', rule: null };
  const ctx = makeContext({ cwd: action.cwd, env });
  const r = decide(action, ctx);
  const settings = ctx.settings().status;
  log(env, { agent: action.agent, tool: action.tool, rule: r.rule, decision: r.decision === 'confirm' && !ASK_VERIFIED[action.agent] ? 'deny' : r.decision, settings });
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
  if (process.platform === 'win32') { process.stderr.write('Cartwright: hard blocks are not available on Windows.\n'); process.exit(0); }
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
    const ctx = makeContext({ cwd: dir });
    const r = decide(action, ctx);
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
