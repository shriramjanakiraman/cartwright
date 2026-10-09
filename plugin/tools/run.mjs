#!/usr/bin/env node
// Run the tools our skills use (the B2C CLI, spec-kit, graphify) without installing them first.
// The version pinned in upstream.lock.json (tracked and updated by the daily upstream check, and smoke-tested
// before each update is proposed) is what runs: an installed copy at that version or newer is used as is;
// otherwise, including an installed copy that's older, the pinned version is fetched on demand through npx
// or uvx and cached. So the whole team stays on the same tested version without reinstalling anything.
// Shipped in the plugin as tools/run.mjs. No dependencies.
//
//   node run.mjs <tool> [args…]        run it: b2c, specify (spec-kit) or graphify, same arguments as usual
//   node run.mjs --check [--json]      installed and pinned versions, what each tool runs as, what's missing
//   node run.mjs --plan <tool> [args…] print the command it would run, without running it
//   node run.mjs --smoke [--markdown]  run each pinned version once and confirm it reports that version
// CARTWRIGHT_USE_PINNED=1 always runs the pinned version; CARTWRIGHT_PREFER_INSTALLED=1 always runs an
// installed copy, even an older one (for machines that may only run pre-approved installs).
// Registry mirrors work as usual: npm_config_registry for npm, UV_DEFAULT_INDEX (or UV_INDEX_URL) for uv.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';

// Each tool: the lock source that pins its version, and how to run it without installing.
export const TOOLS = {
  b2c: { label: 'B2C CLI', source: 'b2c-cli', via: 'npx', package: '@salesforce/b2c-cli', bin: 'b2c',
    install: (v) => `npm install -g @salesforce/b2c-cli@${v}` },
  specify: { label: 'spec-kit', source: 'spec-kit', via: 'uvx-git', repo: 'https://github.com/github/spec-kit.git', bin: 'specify',
    install: (v) => `uv tool install --force specify-cli --from git+https://github.com/github/spec-kit.git@${v}` },
  graphify: { label: 'graphify', source: 'graphify', via: 'uvx', package: 'graphifyy', bin: 'graphify',
    install: (v) => `uv tool install --force graphifyy==${v}` },
};
const ALIASES = { 'spec-kit': 'specify', speckit: 'specify', 'b2c-cli': 'b2c' };

export const RUNTIME_HELP = {
  npx: 'Install Node.js 20 or newer (https://nodejs.org); it includes npx.',
  uvx: WIN
    ? 'Install uv: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    : 'Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh   (or: brew install uv)',
};

// Pinned versions: tools/versions.json in the plugin, or upstream.lock.json in a clone of the library.
export function pinned() {
  for (const p of [join(HERE, 'versions.json'), join(HERE, '..', 'upstream.lock.json')]) {
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j.sources ? Object.fromEntries(Object.entries(j.sources).map(([k, s]) => [k, s.version])) : j;
  }
  return {};
}

// The executable for a command name on PATH, or null.
export function which(cmd) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try { if (statSync(p).isFile()) { accessSync(p, constants.X_OK); return p; } } catch { /* keep looking */ }
    }
  }
  return null;
}

const semver = (s) => (String(s || '').match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
// a < b as versions ("v1.1.2" and "1.1.2" compare equal); false when either is unknown.
export function older(a, b) {
  const x = semver(a), y = semver(b);
  if (x.length < 3 || y.length < 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// The version an installed executable reports, cached by path, size and modification time so normal runs
// don't pay for "--version" again until the tool is reinstalled or upgraded.
const CACHE = join(homedir(), '.cartwright', 'tool-versions.json');
export function installedVersion(path) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(CACHE, 'utf8')); } catch { /* none yet */ }
  let st; try { st = statSync(path); } catch { return null; }
  const key = `${st.size}:${Math.round(st.mtimeMs)}`;
  if (cache[path]?.key === key) return cache[path].version;
  const r = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 15000, shell: WIN, env: { ...process.env, NO_COLOR: '1' } });
  const v = semver(r.stdout).length === 3 ? semver(r.stdout).join('.') : semver(r.stderr).length === 3 ? semver(r.stderr).join('.') : null;
  try { cache[path] = { key, version: v }; mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache, null, 2)); } catch { /* cache is optional */ }
  return v;
}

// How a tool would run right now: { tool, route, command: [exe, ...args], version, pinned, installed, outdated }.
export function plan(name, args = [], versions = pinned()) {
  const id = ALIASES[name] || name;
  const t = TOOLS[id];
  if (!t) return { tool: name, route: 'unknown', error: `unknown tool "${name}"; known: ${Object.keys(TOOLS).join(', ')}` };
  const version = versions[t.source];
  const runner = t.via === 'npx' ? 'npx' : 'uvx';
  const path = which(t.bin);
  const iv = path ? installedVersion(path) : null;
  const outdated = !!(path && version && older(iv, version));
  const installedInfo = path ? { path, version: iv } : null;
  if (path && process.env.CARTWRIGHT_USE_PINNED !== '1' && (!outdated || process.env.CARTWRIGHT_PREFER_INSTALLED === '1' || !which(runner))) {
    return { tool: id, route: 'installed', command: [path, ...args], version: iv || 'installed copy', pinned: version, installed: installedInfo, outdated };
  }
  if (!which(runner)) return { tool: id, route: 'unavailable', missing: runner, fix: RUNTIME_HELP[runner], pinned: version };
  const at = version || 'latest';
  const command = t.via === 'npx'
    ? [runner, '--yes', '--package', `${t.package}@${at}`, t.bin, ...args]
    : t.via === 'uvx'
      ? [runner, '--from', version ? `${t.package}==${version}` : t.package, t.bin, ...args]
      : [runner, '--from', `git+${t.repo}${version ? `@${version}` : ''}`, t.bin, ...args];
  return { tool: id, route: runner, command, version: at, pinned: version, installed: installedInfo, outdated };
}

export function check(versions = pinned()) {
  return Object.keys(TOOLS).map((id) => {
    const p = plan(id, [], versions);
    const t = TOOLS[id];
    return { tool: id, label: t.label, pinned: versions[t.source] || null, installed: p.installed?.version || (p.installed ? 'unknown' : null),
      outdated: !!p.outdated, route: p.route, runsAs: p.command ? p.command.join(' ') : null, missing: p.missing || null, fix: p.fix || null,
      installPermanently: versions[t.source] ? t.install(versions[t.source]) : null };
  });
}

// Run every pinned version once and check it reports that version: used by upstream-watch before it
// proposes a version update, and handy on a new machine.
export function smoke(versions = pinned()) {
  return Object.entries(TOOLS).map(([id, t]) => {
    const want = versions[t.source];
    const p = (() => { const saved = process.env.CARTWRIGHT_USE_PINNED; process.env.CARTWRIGHT_USE_PINNED = '1'; try { return plan(id, ['--version'], versions); } finally { if (saved === undefined) delete process.env.CARTWRIGHT_USE_PINNED; else process.env.CARTWRIGHT_USE_PINNED = saved; } })();
    if (p.route === 'unavailable') return { tool: id, label: t.label, pinned: want, ok: false, detail: `needs ${p.missing}` };
    const r = spawnSync(p.command[0], p.command.slice(1), { encoding: 'utf8', timeout: 600000, shell: WIN, env: { ...process.env, NO_COLOR: '1' } });
    const got = semver(r.stdout).join('.') || semver(r.stderr).join('.');
    const ok = r.status === 0 && !!want && got === semver(want).join('.');
    return { tool: id, label: t.label, pinned: want, ok, detail: ok ? `reports ${got}` : `exit ${r.status}${got ? `, reports ${got}` : ''}: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}` };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [first, ...rest] = process.argv.slice(2);
  if (!first || first === '--help' || first === '-h') {
    console.log(`usage: node run.mjs <${Object.keys(TOOLS).join('|')}> [args…]  |  --check [--json]  |  --plan <tool> [args…]`);
    process.exit(first ? 0 : 2);
  }
  if (first === '--check') {
    const rows = check();
    if (rest.includes('--json')) { console.log(JSON.stringify({ runtimes: { node: process.version, npx: which('npx'), uvx: which('uvx') }, tools: rows }, null, 2)); process.exit(0); }
    for (const r of rows) {
      const how = r.route === 'installed' ? `installed ${r.installed}${r.outdated ? ' (older than pinned; no runner to fetch the pinned one)' : ''}`
        : r.route === 'unavailable' ? `NOT RUNNABLE (needs ${r.missing})`
        : r.outdated ? `installed ${r.installed} is older than pinned → runs ${r.pinned} on demand via ${r.route}` : `runs on demand via ${r.route}`;
      console.log(`${r.label.padEnd(9)} ${how}  [pinned ${r.pinned || 'none'}]`);
      if (r.fix) console.log(`          ${r.fix}`);
      if (r.outdated) console.log(`          update the installed copy: ${r.installPermanently}`);
    }
    process.exit(rows.some((r) => r.route === 'unavailable') ? 1 : 0);
  }
  if (first === '--plan') { console.log(JSON.stringify(plan(rest[0], rest.slice(1)), null, 2)); process.exit(0); }
  if (first === '--smoke') {
    const rows = smoke();
    if (rest.includes('--markdown')) {
      console.log('## Tool versions smoke-tested\n');
      for (const r of rows) console.log(`- ${r.ok ? '✅' : '❌'} **${r.label}** ${r.pinned}: ${r.detail}`);
      if (rows.some((r) => !r.ok)) console.log('\n- [ ] A pinned tool version failed to run. Don\'t merge until it\'s understood; pinning back means editing the lock in a follow-up pull request.');
    } else console.log(JSON.stringify(rows, null, 2));
    process.exit(rows.every((r) => r.ok) ? 0 : 1);
  }

  const p = plan(first, rest);
  if (p.error) { console.error(`run: ${p.error}`); process.exit(2); }
  if (p.route === 'unavailable') { console.error(`run: ${TOOLS[p.tool].label} isn't installed and ${p.missing} isn't available to fetch it. ${p.fix}`); process.exit(127); }
  if (p.outdated && p.route !== 'installed') console.error(`run: installed ${TOOLS[p.tool].label} ${p.installed.version} is older than the team's ${p.pinned}, so running ${p.pinned} on demand. To update the installed copy: ${TOOLS[p.tool].install(p.pinned)}`);
  else if (p.route !== 'installed') console.error(`run: ${TOOLS[p.tool].label} ${p.version} via ${p.route} (first run downloads it; then it's cached)`);
  const r = spawnSync(p.command[0], p.command.slice(1), { stdio: 'inherit', shell: WIN });
  if (r.error) { console.error(`run: ${r.error.message}`); process.exit(127); }
  process.exit(r.status ?? 1);
}
