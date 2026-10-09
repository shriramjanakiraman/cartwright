#!/usr/bin/env node
// Run the tools our skills use (the B2C CLI, spec-kit, graphify) without installing them first.
// An installed copy is used as is; otherwise the tool is fetched on demand at the version pinned in
// upstream.lock.json (the version the daily upstream check tracks) through npx or uvx and cached, so the
// whole team runs the same tested version. Shipped in the plugin as tools/run.mjs. No dependencies.
//
//   node run.mjs <tool> [args…]        run it: b2c, specify (spec-kit) or graphify, same arguments as usual
//   node run.mjs --check [--json]      what's installed, what each tool would run as, what's missing
//   node run.mjs --plan <tool> [args…] print the command it would run, without running it
// Set CARTWRIGHT_USE_PINNED=1 to use the pinned version even when the tool is installed.
// Registry mirrors work as usual: npm_config_registry for npm, UV_DEFAULT_INDEX (or UV_INDEX_URL) for uv.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';

// Each tool: the lock source that pins its version, and how to run it without installing.
export const TOOLS = {
  b2c: { label: 'B2C CLI', source: 'b2c-cli', via: 'npx', package: '@salesforce/b2c-cli', bin: 'b2c',
    install: (v) => `npm install -g @salesforce/b2c-cli@${v}` },
  specify: { label: 'spec-kit', source: 'spec-kit', via: 'uvx-git', repo: 'https://github.com/github/spec-kit.git', bin: 'specify',
    install: (v) => `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@${v}` },
  graphify: { label: 'graphify', source: 'graphify', via: 'uvx', package: 'graphifyy', bin: 'graphify',
    install: (v) => `uv tool install graphifyy==${v}` },
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

// How a tool would run right now: { tool, route, command: [exe, ...args], version, missing }.
export function plan(name, args = [], versions = pinned()) {
  const id = ALIASES[name] || name;
  const t = TOOLS[id];
  if (!t) return { tool: name, route: 'unknown', error: `unknown tool "${name}"; known: ${Object.keys(TOOLS).join(', ')}` };
  const version = versions[t.source];
  const installed = which(t.bin);
  if (installed && process.env.CARTWRIGHT_USE_PINNED !== '1') return { tool: id, route: 'installed', command: [installed, ...args], version: 'installed copy', pinned: version };
  const runner = t.via === 'npx' ? 'npx' : 'uvx';
  if (!which(runner)) return { tool: id, route: 'unavailable', missing: runner, fix: RUNTIME_HELP[runner], pinned: version };
  const at = version || 'latest';
  const command = t.via === 'npx'
    ? [runner, '--yes', '--package', `${t.package}@${at}`, t.bin, ...args]
    : t.via === 'uvx'
      ? [runner, '--from', version ? `${t.package}==${version}` : t.package, t.bin, ...args]
      : [runner, '--from', `git+${t.repo}${version ? `@${version}` : ''}`, t.bin, ...args];
  return { tool: id, route: runner, command, version: at, pinned: version };
}

export function check(versions = pinned()) {
  return Object.keys(TOOLS).map((id) => {
    const p = plan(id, [], versions);
    const t = TOOLS[id];
    return { tool: id, label: t.label, pinned: versions[t.source] || null, route: p.route,
      runsAs: p.command ? p.command.join(' ') : null, missing: p.missing || null, fix: p.fix || null,
      installPermanently: versions[t.source] ? t.install(versions[t.source]) : null };
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
      console.log(`${r.label.padEnd(9)} ${r.route === 'installed' ? 'installed' : r.route === 'unavailable' ? `NOT RUNNABLE (needs ${r.missing})` : `runs on demand via ${r.route}`}  [pinned ${r.pinned || 'none'}]`);
      if (r.fix) console.log(`          ${r.fix}`);
    }
    process.exit(rows.some((r) => r.route === 'unavailable') ? 1 : 0);
  }
  if (first === '--plan') { console.log(JSON.stringify(plan(rest[0], rest.slice(1)), null, 2)); process.exit(0); }

  const p = plan(first, rest);
  if (p.error) { console.error(`run: ${p.error}`); process.exit(2); }
  if (p.route === 'unavailable') { console.error(`run: ${TOOLS[p.tool].label} isn't installed and ${p.missing} isn't available to fetch it. ${p.fix}`); process.exit(127); }
  if (p.route !== 'installed') console.error(`run: ${TOOLS[p.tool].label} ${p.version} via ${p.route} (first run downloads it; then it's cached)`);
  const r = spawnSync(p.command[0], p.command.slice(1), { stdio: 'inherit', shell: WIN });
  if (r.error) { console.error(`run: ${r.error.message}`); process.exit(127); }
  process.exit(r.status ?? 1);
}
