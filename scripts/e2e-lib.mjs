// The small harness the deterministic end-to-end suites share (e2e.mjs, e2e-profile.mjs, e2e-guard.mjs): a throwaway
// work folder with its own home, a bare PATH with only the runtimes a developer must have, a step table that keeps
// going after a failure, and the Markdown report. No dependencies.
//
// Concurrency: a suite whose steps are independent (each builds its own folders) can ask for `concurrency`. Its steps
// are then only declared as the script runs; report() starts that many copies of the script, each running a share of
// the steps in its own work folder, and prints the results in the declared order. Without it, each step runs at once,
// as declared (e2e.mjs relies on that order).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
export const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 600000, ...o });
export const json = (r) => { assert(r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`); return JSON.parse(r.stdout); };
export const which = (c) => { const r = spawnSync('/usr/bin/which', [c], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const SHARD = process.env.CARTWRIGHT_E2E_SHARD; // "<index>/<count>" in a child running a share of the steps
const MARK = '\u0001cartwright-e2e-results ';

// A folder for test work that isn't inside the system's temporary folders, for suites that must tell "outside the
// project and outside temp" apart (on Linux the default temp folder is /tmp itself).
export function workBase() {
  if (process.env.RUNNER_TEMP) return process.env.RUNNER_TEMP;
  const t = realpathSync(tmpdir());
  if (!/^\/(private\/)?(var\/)?tmp(\/|$)/.test(t)) return t;
  const d = join(homedir(), '.cache', 'cartwright-tests');
  mkdirSync(d, { recursive: true });
  return d;
}

export function harness(prefix, { concurrency = 1, base } = {}) {
  // Real path for the work folder (macOS's tmpdir is behind a symlink); symlinked starts are tested on purpose.
  const WORK = mkdtempSync(join(realpathSync(base || tmpdir()), prefix));
  const HOME = join(WORK, 'home');
  mkdirSync(HOME);
  // A folder of symlinks to just these commands, for a PATH that holds nothing else.
  const binDir = (name, cmds) => { const d = join(WORK, name); mkdirSync(d); for (const c of cmds) if (which(c)) symlinkSync(which(c), join(d, c)); return d; };
  const BARE = `${binDir('bin-bare', ['node', 'npx', 'npm', 'git', 'gh'])}:/usr/bin:/bin`;
  const pool = Math.max(1, Number(process.env.CARTWRIGHT_E2E_CONCURRENCY) || concurrency);
  const deferred = pool > 1 || !!SHARD;
  const declared = [], results = [];
  const run = (name, fn) => {
    // A step that returns "skipped: <why>" didn't check anything: it's reported as skipped, not passed.
    try { const detail = fn() || ''; return { name, ok: true, skipped: /^skipped\b/.test(detail), detail }; }
    catch (e) { return { name, ok: false, detail: String(e.message || e).split('\n').slice(0, 3).join(' ') }; }
  };
  function step(name, fn) {
    if (deferred) declared.push({ name, fn }); else results.push(run(name, fn));
  }
  const print = (title, list, keep) => {
    console.log(`## ${title}\n`);
    console.log('| | Step | Result |\n|---|---|---|');
    for (const r of list) console.log(`| ${r.skipped ? '⏭️' : r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`);
    const failed = list.filter((r) => !r.ok).length, skipped = list.filter((r) => r.skipped).length;
    console.log(`\n${list.length - failed - skipped}/${list.length} passed${skipped ? `, ${skipped} skipped` : ''}${keep ? `; work folder kept: ${WORK}` : ''}`);
    return failed ? 1 : 0;
  };
  // Run what's declared (concurrently if asked), print the report, remove the work folder unless kept, and return the
  // exit code. In a child, print this share's results for the parent instead.
  async function report(title, { keep = false } = {}) {
    let list = results;
    if (SHARD) {
      const [i, n] = SHARD.split('/').map(Number);
      const mine = declared.map((d, k) => [k, d]).filter(([k]) => k % n === i).map(([k, d]) => ({ k, ...run(d.name, d.fn) }));
      process.stdout.write(`${MARK}${JSON.stringify(mine)}\n`);
      if (!keep) rmSync(WORK, { recursive: true, force: true });
      return 0;
    }
    if (deferred) {
      const n = Math.min(pool, declared.length) || 1;
      const shares = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((done) => {
        const child = spawn(process.execPath, process.argv.slice(1), { env: { ...process.env, CARTWRIGHT_E2E_SHARD: `${i}/${n}` }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => {
          const line = out.split('\n').find((l) => l.startsWith(MARK));
          if (line) return done(JSON.parse(line.slice(MARK.length)));
          // The child failed before reporting: its steps fail with what it said.
          done(declared.map((d, k) => [k, d]).filter(([k]) => k % n === i).map(([k, d]) => ({ k, name: d.name, ok: false, detail: `the test process stopped (exit ${code}): ${err.trim().split('\n').slice(-2).join(' ').slice(0, 300)}` })));
        });
      })));
      list = shares.flat().sort((a, b) => a.k - b.k);
    }
    const code = print(title, list, keep);
    if (!keep) rmSync(WORK, { recursive: true, force: true });
    return code;
  }
  return { WORK, HOME, BARE, binDir, results, step, report };
}

// About half the machine's CPUs, for suites that run concurrently.
export const halfTheCpus = () => Math.max(1, Math.floor((availableParallelism?.() || 2) / 2));
