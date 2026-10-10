#!/usr/bin/env node
// Offline regressions for kit merging, link ownership and installed-tool fallbacks. All fixtures stay in TMPDIR.
// Also run by test-release.mjs against the built plugin; standalone: node scripts/test-kit-link.mjs [--plugin <dir>].
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tools = args.includes('--plugin') ? resolve(args[args.indexOf('--plugin') + 1], 'tools') : join(ROOT, 'scripts');
const WORK = mkdtempSync(join(realpathSync(tmpdir()), 'cartwright-kit-link-'));
const env = { ...process.env, HOME: join(WORK, 'home'), CARTWRIGHT_STATE_DIR: join(WORK, 'state'),
  CARTWRIGHT_USE_PINNED: '', CARTWRIGHT_PREFER_INSTALLED: '' };
mkdirSync(env.HOME);
const { applyKit, kitFiles } = await import(pathToFileURL(join(tools, 'kit.mjs')));
const opts = { code: 'zzt', overlay: 'example/zzt-cartwright' };
const jsonFiles = ['.claude/settings.json', '.github/copilot/settings.json', '.agents/plugins/marketplace.json'];
const put = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const folder = (name) => { const p = join(WORK, name); mkdirSync(p); return p; };
const node = (script, a, cwd = WORK, extra = {}) => spawnSync(process.execPath, [script, ...a], {
  cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000,
});
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map((name) => {
  const p = join(dir, name), st = lstatSync(p);
  return [name, st.isSymbolicLink() ? { link: readlinkSync(p) } : st.isDirectory() ? snapshot(p) : readFileSync(p, 'utf8')];
}));
let passed = 0, failed = 0;
function step(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack || e}`); }
}

try {
  for (const [i, bad] of jsonFiles.entries()) for (const populate of [false, true]) {
    step(`malformed ${bad}: no writes (${populate ? 'existing kit' : 'other files absent'})`, () => {
      const dir = folder(`bad-${i}-${populate}`);
      if (populate) for (const [rel, text] of kitFiles(opts)) put(join(dir, rel), text);
      put(join(dir, bad), '{broken JSON\n');
      const before = snapshot(dir);
      assert.throws(() => applyKit(dir, opts), (e) => e.message.includes(join(dir, bad)) && e.message.includes('fix or remove'));
      assert.deepEqual(snapshot(dir), before);
      const cli = node(join(tools, 'setup.mjs'), ['kit', '--code', opts.code, '--overlay', opts.overlay], dir);
      assert.equal(cli.status, 1, cli.stderr);
      assert(cli.stderr.includes(join(dir, bad)) && cli.stderr.includes('fix or remove'), cli.stderr);
      assert.equal(cli.stdout, '');
      assert.deepEqual(snapshot(dir), before);
    });
  }

  step('valid kit merges preserve settings and existing marketplace, and remain idempotent', () => {
    const dir = folder('valid');
    put(join(dir, jsonFiles[0]), JSON.stringify({ custom: true, enabledPlugins: { other: false } }));
    put(join(dir, jsonFiles[1]), JSON.stringify({ custom: 'copilot' }));
    put(join(dir, jsonFiles[2]), JSON.stringify({ name: 'custom-market', plugins: [{ name: 'other' }] }));
    const changed = applyKit(dir, opts);
    assert(Array.isArray(changed));
    assert.equal(changed.length, 5);
    assert.deepEqual(changed.notes, []);
    assert.deepEqual(JSON.parse(JSON.stringify(changed)), [...changed]);
    assert.equal(JSON.parse(readFileSync(join(dir, jsonFiles[0]))).custom, true);
    assert.equal(JSON.parse(readFileSync(join(dir, jsonFiles[0]))).enabledPlugins.other, false);
    assert.equal(JSON.parse(readFileSync(join(dir, jsonFiles[1]))).custom, 'copilot');
    const marketplace = JSON.parse(readFileSync(join(dir, jsonFiles[2])));
    assert.equal(marketplace.name, 'custom-market');
    assert(marketplace.plugins.some((p) => p.name === 'other'));
    assert(readFileSync(join(dir, '.codex/config.toml'), 'utf8').includes('cartwright@custom-market'));
    assert.deepEqual(applyKit(dir, opts), []);
  });

  step('disabled Codex plugins stay disabled and are reported by the API and kit command', () => {
    const dir = folder('disabled');
    put(join(dir, jsonFiles[2]), JSON.stringify({ name: 'custom-market', plugins: [] }));
    const toml = '# keep choices\r\n[plugins."cartwright@custom-market"] # core\r\nenabled = false # deliberately off\r\n'
      + '[plugins."zzt-skills@custom-market"]\r\n enabled=false\r\n[plugins."other@other"]\r\nenabled = true\r\n';
    put(join(dir, '.codex/config.toml'), toml);
    const notes = ['cartwright', 'zzt-skills'].map((name) => `${name} is switched off in .codex/config.toml; set enabled = true to use it`);
    assert.deepEqual(applyKit(dir, opts).notes, notes);
    assert.equal(readFileSync(join(dir, '.codex/config.toml'), 'utf8'), toml);
    assert.deepEqual(applyKit(dir, opts), []);
    const cli = node(join(tools, 'setup.mjs'), ['kit', '--code', opts.code, '--overlay', opts.overlay], dir);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout).notes, notes);
    assert.deepEqual(JSON.parse(cli.stdout).changed, []);
    assert.equal(readFileSync(join(dir, '.codex/config.toml'), 'utf8'), toml);
  });

  step('Codex notes belong to the matching section; missing plugin entries are enabled', () => {
    const dir = folder('enabled');
    const toml = '[plugins."cartwright@zzt-project"]\nenabled = true\n[plugins."other@other"]\nenabled = false\n';
    put(join(dir, '.codex/config.toml'), toml);
    assert.deepEqual(applyKit(dir, opts).notes, []);
    assert.equal(readFileSync(join(dir, '.codex/config.toml'), 'utf8'), `${toml}\n[plugins."zzt-skills@zzt-project"]\nenabled = true\n`);
  });

  const link = (dir, extra = []) => node(join(ROOT, 'scripts/link.mjs'), ['--agent', 'codex', '--scope', 'project', '--project-dir', dir, ...extra]);
  step('core link leaves foreign absolute, relative, dangling links and ordinary files alone', () => {
    const dir = folder('core-links'), target = join(dir, '.codex/skills');
    mkdirSync(target, { recursive: true });
    const skills = readdirSync(join(ROOT, 'plugin/skills')).sort().slice(0, 4);
    assert.equal(skills.length, 4);
    const foreign = folder('foreign-core');
    symlinkSync(foreign, join(target, skills[0]));
    symlinkSync(relative(target, foreign), join(target, skills[1]));
    symlinkSync(join(foreign, 'missing'), join(target, skills[2]));
    put(join(target, skills[3]), 'user file\n');
    const before = snapshot(target);
    const dry = link(dir, ['--dry-run']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(snapshot(target), before);
    const cli = link(dir);
    assert.equal(cli.status, 0, cli.stderr);
    for (const name of skills) {
      assert(cli.stderr.includes(`${join(target, name)} points elsewhere; left alone`), cli.stderr);
      assert.deepEqual(snapshot(target)[name], before[name]);
    }
    assert.deepEqual(snapshot(foreign), {});
    const again = link(dir);
    assert.equal(again.status, 0, again.stderr);
    assert(again.stdout.includes('0 linked'), again.stdout);
  });

  step('overlay link preserves foreign entries and folder links, relinks and prunes only owned links', () => {
    const dir = folder('overlay-links'), overlay = folder('overlay'), source = join(overlay, 'skills');
    mkdirSync(source);
    const target = join(dir, '.codex/skills');
    mkdirSync(target, { recursive: true });
    for (const name of ['foreign', 'relative', 'dangling', 'file', 'folder', 'moved', 'current', 'new']) {
      put(join(source, `${name}.md`), `---\nname: ${name}\nstatus: active\n---\nFixture\n`);
    }
    const foreign = folder('foreign-overlay');
    // A sibling with the same prefix must not count as part of the source.
    const prefixSibling = join(overlay, 'skills-elsewhere'); mkdirSync(prefixSibling);
    for (const name of ['foreign', 'relative', 'dangling', 'file', 'moved', 'current', 'removed', 'unowned']) mkdirSync(join(target, name));
    symlinkSync(prefixSibling, join(target, 'foreign/SKILL.md'));
    symlinkSync(relative(join(target, 'relative'), foreign), join(target, 'relative/SKILL.md'));
    symlinkSync(join(foreign, 'missing'), join(target, 'dangling/SKILL.md'));
    put(join(target, 'file/SKILL.md'), 'user file');
    symlinkSync(foreign, join(target, 'folder'));
    symlinkSync(relative(join(target, 'moved'), join(source, 'old.md')), join(target, 'moved/SKILL.md'));
    symlinkSync(join(source, 'current.md'), join(target, 'current/SKILL.md'));
    symlinkSync(relative(join(target, 'removed'), join(source, 'removed.md')), join(target, 'removed/SKILL.md'));
    symlinkSync(prefixSibling, join(target, 'unowned/SKILL.md'));
    const before = snapshot(target);
    assert.equal(link(dir, ['--from', overlay, '--dry-run']).status, 0);
    assert.deepEqual(snapshot(target), before);
    const cli = link(dir, ['--from', overlay]);
    assert.equal(cli.status, 0, cli.stderr);
    for (const name of ['foreign', 'relative', 'dangling', 'file', 'folder', 'unowned']) assert.deepEqual(snapshot(target)[name], before[name]);
    for (const name of ['foreign', 'relative', 'dangling', 'file']) assert(cli.stderr.includes(`${join(target, name, 'SKILL.md')} points elsewhere; left alone`));
    assert(cli.stderr.includes(`${join(target, 'folder')} points elsewhere; left alone`));
    for (const name of ['moved', 'current', 'new']) assert.equal(readlinkSync(join(target, name, 'SKILL.md')), join(source, `${name}.md`));
    assert(!existsSync(join(target, 'removed')));
    assert.deepEqual(snapshot(foreign), {});
    assert.deepEqual(snapshot(prefixSibling), {});
    assert(link(dir, ['--from', overlay]).stdout.includes('0 linked'));
  });

  for (const [tool, runner] of [['b2c', 'npx'], ['graphify', 'uvx']]) {
    step(`${tool}: old installed fallback explains the missing ${runner}; route and overrides are unchanged`, () => {
      const bin = folder(`bin-${tool}`);
      put(join(bin, tool), '#!/bin/sh\necho 0.0.1\n');
      // Executable fixtures need no tools or network, even with an otherwise empty PATH.
      chmodSync(join(bin, tool), 0o755);
      const plan = (extra = {}) => JSON.parse(node(join(tools, 'run.mjs'), ['--plan', tool], WORK, { PATH: bin, ...extra }).stdout);
      const fallback = plan();
      assert.equal(fallback.route, 'installed');
      assert.equal(fallback.outdated, true);
      assert(fallback.note.includes('older than') && fallback.note.includes(`${runner} is missing`), fallback.note);
      const check = JSON.parse(node(join(tools, 'run.mjs'), ['--check', '--json'], WORK, { PATH: bin }).stdout);
      assert.equal(check.tools.find((row) => row.tool === tool).note, fallback.note);
      const run = node(join(tools, 'run.mjs'), [tool, '--version'], WORK, { PATH: bin });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), '0.0.1');
      assert(run.stderr.includes(`${runner} is missing`), run.stderr);
      assert.equal(plan({ CARTWRIGHT_USE_PINNED: '1' }).route, 'unavailable');
      put(join(bin, runner), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, runner), 0o755);
      assert.equal(plan().route, runner);
      const preferred = plan({ CARTWRIGHT_PREFER_INSTALLED: '1' });
      assert.equal(preferred.route, 'installed');
      assert(preferred.note.includes('CARTWRIGHT_PREFER_INSTALLED=1'), preferred.note);
      assert.equal(plan({ CARTWRIGHT_USE_PINNED: '1', CARTWRIGHT_PREFER_INSTALLED: '1' }).route, runner);
      put(join(bin, tool), '#!/bin/sh\necho version-unknown\n');
      const unknown = plan();
      assert.equal(unknown.route, 'installed');
      assert.equal(unknown.outdated, false);
      assert.equal(unknown.installed.version, null);
      const unknownCheck = JSON.parse(node(join(tools, 'run.mjs'), ['--check', '--json'], WORK, { PATH: bin }).stdout);
      assert.equal(unknownCheck.tools.find((row) => row.tool === tool).installed, 'unknown');
    });
  }
} finally {
  rmSync(WORK, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed (offline; ${tools})`);
process.exitCode = failed ? 1 : 0;
