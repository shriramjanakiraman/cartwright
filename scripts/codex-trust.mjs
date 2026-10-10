#!/usr/bin/env node
// Codex runs a plugin's hooks only after the user trusts them, and trusts each hook by a hash it computes over the
// hook's entry in hooks.json (command, matcher, timeout). The agent tests pre-seed that trust in a throwaway Codex
// home, so they need the hashes Codex computes for the current hooks.json. This captures them once, and checks they
// still match whenever hooks.json changes (which is rare by design: decision records 0012 and 0013).
//
//   node scripts/codex-trust.mjs capture [--plugin ./plugin]   install the built plugin in a throwaway CODEX_HOME,
//                                                              ask Codex's app server for the hooks' hashes
//                                                              (hooks/list), seed them, confirm Codex now reports
//                                                              the hooks as trusted, and record the hashes in
//                                                              tests/codex-hook-trust.json. No model call and no
//                                                              sign-in needed
//   node scripts/codex-trust.mjs check [--plugin ./plugin]     exit 1 if hooks.json changed since the capture
//   node scripts/codex-trust.mjs list --home <dir> --cwd <dir>  print Codex's hooks/list for that home, as JSON
// Codex runs through npx at CODEX_VERSION; nothing is installed globally. Never uses --dangerously-bypass-hook-trust.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CODEX_VERSION = '0.162.1';
export const CODEX = ['-y', `@openai/codex@${CODEX_VERSION}`];
export const TRUST_FILE = join(ROOT, 'tests', 'codex-hook-trust.json');
export const PLUGIN_ID = 'cartwright@cartwright';
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
export const hooksSha = (plugin) => createHash('sha256').update(readFileSync(join(plugin, 'hooks', 'hooks.json'))).digest('hex');

// A marketplace folder Codex can install from: the repo's Codex marketplace file and a copy of the plugin.
export function localMarketplace(dir, plugin) {
  mkdirSync(join(dir, '.agents', 'plugins'), { recursive: true });
  cpSync(join(ROOT, '.agents', 'plugins', 'marketplace.json'), join(dir, '.agents', 'plugins', 'marketplace.json'));
  cpSync(plugin, join(dir, 'plugin'), { recursive: true });
  return dir;
}
// The config.toml lines that pre-seed trust for the recorded hashes.
export const trustToml = (trusted) => Object.entries(trusted).map(([k, v]) => `\n[hooks.state."${k}"]\ntrusted_hash = "${v}"\n`).join('');

// A throwaway CODEX_HOME with the plugin installed from a local marketplace. With `trusted`, the hooks' trust is
// pre-seeded; with `auth`, that sign-in file is copied in (the caller deletes the home afterwards).
export function prepareHome(work, plugin, { trusted, auth, env = process.env, cwd = work } = {}) {
  const home = join(work, 'codex-home');
  mkdirSync(home, { recursive: true });
  const market = localMarketplace(join(work, 'codex-market'), plugin);
  const e = { ...env, CODEX_HOME: home };
  for (const a of [['plugin', 'marketplace', 'add', market], ['plugin', 'add', PLUGIN_ID]]) {
    const r = spawnSync('npx', [...CODEX, ...a], { cwd, env: e, encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) throw new Error(`codex ${a.join(' ')}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  }
  if (trusted) appendFileSync(join(home, 'config.toml'), trustToml(trusted));
  if (auth) cpSync(auth, join(home, 'auth.json'));
  return home;
}

// Codex's own view of the hooks in a home, from its app server (initialize, then hooks/list): [{ key, currentHash,
// trustStatus, … }]. The app server exits when its input closes, before answering, so this talks to it in turns.
export function listHooks(home, cwd, env = process.env) {
  return new Promise((done, fail) => {
    const p = spawn('npx', [...CODEX, 'app-server', '--listen', 'stdio://'], { cwd, env: { ...env, CODEX_HOME: home } });
    let buf = '', err = '';
    const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
    const timer = setTimeout(() => { p.kill(); fail(new Error(`codex app-server didn't answer hooks/list: ${err.trim().slice(0, 300)}`)); }, 120000);
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) > -1;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } }); }
        if (m.id === 2) {
          clearTimeout(timer); p.kill();
          if (m.error) fail(new Error(`hooks/list: ${JSON.stringify(m.error).slice(0, 300)}`));
          else done((m.result?.data || []).flatMap((d) => d.hooks || []));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cartwright-tests', version: '1' } } });
  });
}

// Stop the home's app-server daemon: it caches the hook configuration, so each step starts it fresh.
export const stopDaemon = (home, cwd, env = process.env) =>
  spawnSync('npx', [...CODEX, 'app-server', 'daemon', 'stop'], { cwd, env: { ...env, CODEX_HOME: home }, encoding: 'utf8', timeout: 60000 });

function check(plugin) {
  if (!existsSync(TRUST_FILE)) { console.error(`codex-trust: ${TRUST_FILE} is missing; run node scripts/codex-trust.mjs capture`); process.exit(1); }
  const t = JSON.parse(readFileSync(TRUST_FILE, 'utf8'));
  if (t.hooksJsonSha256 !== hooksSha(plugin)) {
    console.error('codex-trust: plugin/hooks/hooks.json changed since the Codex trust hashes were captured. Every Codex user will be asked to approve the hooks again (decision record 0012), and the agent tests need new hashes: run node scripts/codex-trust.mjs capture, and commit tests/codex-hook-trust.json.');
    process.exit(1);
  }
  console.log(`codex-trust: hooks.json matches the captured trust hashes (${Object.keys(t.trusted).length} hooks, Codex ${t.codexVersion})`);
}

async function capture(plugin) {
  const work = mkdtempSync(join(realpathSync(tmpdir()), 'cartwright-codex-trust-'));
  try {
    const project = join(work, 'project');
    mkdirSync(project);
    spawnSync('git', ['init', '-q'], { cwd: project });
    const home = prepareHome(work, plugin, { cwd: project });
    const ours = (hooks) => hooks.filter((h) => h.pluginId === PLUGIN_ID);
    const before = ours(await listHooks(home, project));
    if (!before.length) throw new Error('Codex lists none of the plugin\'s hooks');
    const trusted = Object.fromEntries(before.map((h) => [h.key, h.currentHash]).sort(([a], [b]) => (a < b ? -1 : 1)));
    // Seed them and ask again: Codex itself must now call every hook trusted.
    appendFileSync(join(home, 'config.toml'), trustToml(trusted));
    const after = ours(await listHooks(home, project));
    const notTrusted = after.filter((h) => h.trustStatus !== 'trusted');
    if (notTrusted.length || after.length !== before.length) throw new Error(`seeded trust didn't take: ${notTrusted.map((h) => `${h.key} ${h.trustStatus}`).join(', ')}`);
    stopDaemon(home, project);
    writeFileSync(TRUST_FILE, JSON.stringify({ _comment: 'Codex trust hashes for the plugin\'s hooks.json, captured by node scripts/codex-trust.mjs capture. Recapture whenever hooks.json changes.', codexVersion: CODEX_VERSION, hooksJsonSha256: hooksSha(plugin), trusted }, null, 2) + '\n');
    console.log(`codex-trust: captured ${Object.keys(trusted).length} hook hashes into ${TRUST_FILE}`);
  } finally {
    if (args.includes('--keep')) console.error(`codex-trust: work folder kept: ${work}`); else rmSync(work, { recursive: true, force: true });
  }
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const plugin = resolve(opt('--plugin', join(ROOT, 'plugin')));
  const fail = (e) => { console.error(`codex-trust: ${e.message || e}`); process.exit(1); };
  if (args[0] === 'capture') capture(plugin).catch(fail);
  else if (args[0] === 'check') check(plugin);
  else if (args[0] === 'list' && opt('--home') && opt('--cwd')) listHooks(opt('--home'), opt('--cwd')).then((h) => console.log(JSON.stringify(h))).catch(fail);
  else { console.error('usage: codex-trust.mjs capture | check [--plugin ./plugin] | list --home <dir> --cwd <dir>'); process.exit(2); }
}
