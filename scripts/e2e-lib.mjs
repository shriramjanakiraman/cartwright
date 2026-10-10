// The small harness the deterministic end-to-end suites share (e2e.mjs, e2e-profile.mjs): a throwaway work folder
// with its own home, a bare PATH with only the runtimes a developer must have, a step table that keeps going
// after a failure, and the Markdown report. No dependencies.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
export const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { encoding: 'utf8', timeout: 600000, ...o });
export const json = (r) => { assert(r.status === 0, `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`); return JSON.parse(r.stdout); };
export const which = (c) => { const r = spawnSync('/usr/bin/which', [c], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

export function harness(prefix) {
  // Real path for the work folder (macOS's tmpdir is behind a symlink); symlinked starts are tested on purpose.
  const WORK = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  const HOME = join(WORK, 'home');
  mkdirSync(HOME);
  // A folder of symlinks to just these commands, for a PATH that holds nothing else.
  const binDir = (name, cmds) => { const d = join(WORK, name); mkdirSync(d); for (const c of cmds) if (which(c)) symlinkSync(which(c), join(d, c)); return d; };
  const BARE = `${binDir('bin-bare', ['node', 'npx', 'npm', 'git', 'gh'])}:/usr/bin:/bin`;
  const results = [];
  // A step that returns "skipped: <why>" didn't check anything: it's reported as skipped, not passed.
  function step(name, fn) {
    try { const detail = fn() || ''; results.push({ name, ok: true, skipped: /^skipped\b/.test(detail), detail }); }
    catch (e) { results.push({ name, ok: false, detail: String(e.message || e).split('\n').slice(0, 3).join(' ') }); }
  }
  // Print the report, remove the work folder unless kept, and return the exit code.
  function report(title, { keep = false } = {}) {
    console.log(`## ${title}\n`);
    console.log('| | Step | Result |\n|---|---|---|');
    for (const r of results) console.log(`| ${r.skipped ? '⏭️' : r.ok ? '✅' : '❌'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`);
    const failed = results.filter((r) => !r.ok).length, skipped = results.filter((r) => r.skipped).length;
    console.log(`\n${results.length - failed - skipped}/${results.length} passed${skipped ? `, ${skipped} skipped` : ''}${keep ? `; work folder kept: ${WORK}` : ''}`);
    if (!keep) rmSync(WORK, { recursive: true, force: true });
    return failed ? 1 : 0;
  }
  return { WORK, HOME, BARE, binDir, results, step, report };
}
