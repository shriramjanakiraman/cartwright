#!/usr/bin/env node
// Deterministic test of the project profiler and its files, against a copy of the built plugin only: the fixture
// projects in tests/projects/ are turned into git repos (with a local bare remote) in a throwaway folder, profiled,
// and compared with their expected profiles in tests/expected/. Covers detection and "not found", secrets never
// leaking, reproducible output, read-only study, drift and refresh, the settings content, the personal file and
// its merge rules, the three storage modes, and broken settings. Offline; no agents; free.
//
// Usage: node scripts/e2e-profile.mjs [--plugin ./plugin] [--keep] [--update-goldens]
//   --update-goldens   rewrite tests/expected/*.profile.json from this run (review the diff before committing)
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, harness, json, sh } from './e2e-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const KEEP = args.includes('--keep');
const UPDATE = args.includes('--update-goldens');
const { WORK, HOME, BARE, step, report } = harness('cartwright-profile-');
const NODE = join(BARE.split(':')[0], 'node');
const STATE = join(WORK, 'state');
const PLUGIN = join(WORK, 'plugin');
cpSync(resolve(opt('--plugin', join(ROOT, 'plugin'))), PLUGIN, { recursive: true });
const PROFILE = join(PLUGIN, 'tools', 'profile.mjs');
const { HIDDEN } = await import(pathToFileURL(join(PLUGIN, 'tools', 'secret-rules.mjs')));
const { isTightening, teamDefaults, validateSettings } = await import(pathToFileURL(join(PLUGIN, 'tools', 'settings.mjs')));
const { makeCtx } = await import(pathToFileURL(join(PLUGIN, 'tools', 'profile.mjs')));

const env = (extra = {}) => ({ HOME, PATH: BARE, NO_COLOR: '1', CARTWRIGHT_STATE_DIR: STATE, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', ...extra });
const git = (cwd, ...a) => { const r = sh('git', ['-c', 'commit.gpgsign=false', ...a], { cwd, env: env({ GIT_OPTIONAL_LOCKS: '0' }) }); assert(r.status === 0, `git ${a.join(' ')}: ${r.stderr.trim()}`); return r.stdout; };
const profile = (cwd, a, extra) => sh(NODE, [PROFILE, ...a], { cwd, env: env(extra) });
const ok = (cwd, a, extra) => json(profile(cwd, a, extra));
const read = (p) => readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
const put = (dir, rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
const editJson = (p, fn) => { const j = readJson(p); fn(j); writeFileSync(p, JSON.stringify(j, null, 2) + '\n'); };
const commitAll = (dir, msg = 'change') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };
const clean = (dir) => git(dir, 'status', '--porcelain').trim() === '';

// A fixture as a git repo: committed on main with a develop branch, pushed to a local bare remote, then cloned
// (so origin/HEAD is set, as in a real clone). `edit` changes the files before the first commit. Each fixture is
// built once; later calls get their own copy of the clone and of its remote.
let seq = 0;
const built = new Map();
function project(fixture, edit) {
  if (fixture && !edit && built.has(fixture)) {
    const t = built.get(fixture), id = `${fixture}-${++seq}`;
    const bare = join(WORK, 'remotes', `${id}.git`), dir = join(WORK, 'p', id);
    cpSync(t.bare, bare, { recursive: true, preserveTimestamps: true });
    cpSync(t.dir, dir, { recursive: true, preserveTimestamps: true });
    git(dir, 'remote', 'set-url', 'origin', bare);
    return { dir, bare };
  }
  const made = build(fixture, edit);
  if (fixture && !edit) { built.set(fixture, made); return project(fixture); }
  return made;
}
function build(fixture, edit) {
  const id = `${fixture || 'generated'}-${++seq}`;
  const src = join(WORK, 'src', id);
  if (fixture) cpSync(join(ROOT, 'tests', 'projects', fixture), src, { recursive: true }); else mkdirSync(src, { recursive: true });
  if (edit) edit(src);
  git(src, 'init', '-q', '-b', 'main');
  commitAll(src, 'fixture');
  git(src, 'branch', 'develop');
  const bare = join(WORK, 'remotes', `${id}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(WORK, 'init', '-q', '--bare', '-b', 'main', bare);
  git(src, 'push', '-q', bare, 'main', 'develop');
  return { dir: clone(bare, id), bare };
}
const clone = (bare, id) => { const d = join(WORK, 'p', `${id}-${++seq}`); git(WORK, 'clone', '-q', bare, d); return d; };

// Every found fact names where it came from.
function unsourced(p) {
  const bad = [];
  for (const [k, f] of Object.entries(p.facts)) {
    if (k === 'commands') { for (const [c, x] of Object.entries(f)) if (x.status === 'found' && !x.source) bad.push(`commands.${c}`); continue; }
    if (f.status !== 'found') continue;
    if (Array.isArray(f.value)) { if (!f.source && f.value.some((v) => !v.source)) bad.push(k); } else if (!f.source) bad.push(k);
  }
  for (const [k, c] of Object.entries(p.conventions)) if (c.status === 'found' && !c.path && !c.source && !c.value?.every((v) => v.path)) bad.push(`conventions.${k}`);
  return bad;
}
const notFound = (x) => x?.status === 'not found';
// New settings need both lists on the command line; most steps confirm these.
const LISTS = ['--protected', 'develop,main', '--generated', 'none'];

// --- A1–A6: detection, sources, "not found", conventions -----------------------------------------------------
const FIXTURES = ['sfra', 'storefront-next', 'ts', 'python', 'unknown-stack'];
const P = {};
for (const name of FIXTURES) {
  step(`${name}: the profile matches tests/expected/${name}.profile.json, every fact with its source`, () => {
    const { dir } = project(name);
    const w = ok(dir, ['write', '--store', 'folder', ...LISTS]);
    assert(w.changed.includes('.cartwright/profile.json'), `nothing written: ${JSON.stringify(w)}`);
    const got = read(join(dir, '.cartwright', 'profile.json'));
    const golden = join(ROOT, 'tests', 'expected', `${name}.profile.json`);
    if (UPDATE) { mkdirSync(dirname(golden), { recursive: true }); writeFileSync(golden, got); }
    assert(existsSync(golden), `no expected profile; run with --update-goldens and review it`);
    assert(got === read(golden), `differs from the expected profile (run with --update-goldens and review the diff)`);
    P[name] = JSON.parse(got);
    const bad = unsourced(P[name]);
    assert(!bad.length, `facts without a source: ${bad.join(', ')}`);
    return UPDATE ? 'expected profile rewritten' : 'identical';
  });
}

step('Storefront Next (A2): B2C Commerce, Storefront Next flavour, pnpm, commands and layout; never SFRA', () => {
  const p = P['storefront-next']; assert(p, 'no profile');
  assert(p.facts.platform.value === 'Salesforce B2C Commerce' && p.facts.platform.flavour === 'storefront-next', JSON.stringify(p.facts.platform));
  assert(p.facts.packageManager.value === 'pnpm' && p.facts.commands.test.run === 'pnpm test' && p.facts.commands.build.defined.includes('cartridge:generate'), 'commands');
  assert(p.facts.layout.value.cartridges?.includes('app_storefrontnext_base'), 'cartridge layout');
  assert(!/sfra/i.test(JSON.stringify(p.facts)) && p.guidance.avoidSkills.includes('b2c-isml'), 'SFRA recorded, or SFRA skills not avoided');
  return `${p.facts.platform.flavour} (${p.facts.platform.source}), prefer ${p.guidance.preferSkills.join(', ')}`;
});

step('TypeScript/pnpm (A3): TypeScript, Node pin, pnpm, framework versions, own commands, layout; nothing about SFCC', () => {
  const p = P.ts; assert(p, 'no profile');
  assert(p.facts.languages.value.some((l) => l.value === 'TypeScript') && p.facts.node.value === '20.18.0', 'TypeScript or Node pin');
  assert(p.facts.packageManager.value === 'pnpm' && p.facts.packageManager.source === 'pnpm-lock.yaml', 'pnpm from its lockfile');
  assert(p.facts.frameworks.value.find((f) => f.name === 'fastify')?.version === '4.28.1', 'framework version');
  const c = p.facts.commands;
  assert(c.build.defined === 'tsc -p tsconfig.json' && c.test.defined === 'vitest run' && c.lint.defined === 'eslint .', 'commands not exactly as defined');
  assert(notFound(p.facts.platform) && !/salesforce|sfcc|cartridge|b2c/i.test(JSON.stringify(p)), 'mentions SFCC');
  return `${c.build.run} · ${c.test.run} · ${c.lint.run}`;
});

step('Python (A4): Python pin, pyproject + uv, pytest as the test command, layout; nothing about SFCC', () => {
  const p = P.python; assert(p, 'no profile');
  assert(p.facts.languages.value[0].value === 'Python' && p.facts.python.value === '3.12.7', 'Python or its pin');
  assert(p.facts.packageManager.value === 'uv' && p.facts.commands.test.run === 'uv run pytest' && p.facts.commands.test.source === 'pyproject.toml#tool.pytest.ini_options', 'pytest');
  assert(p.facts.layout.value.packages?.includes('sample_pricing'), 'package layout');
  assert(notFound(p.facts.platform) && !/salesforce|sfcc|cartridge|b2c/i.test(JSON.stringify(p)), 'mentions SFCC');
  return `${p.facts.commands.test.run} (${p.facts.commands.test.how}, ${p.facts.commands.test.source})`;
});

step('unknown stack and missing commands (A5): every undetected fact is "not found", nothing invented', () => {
  const p = P['unknown-stack']; assert(p, 'no profile');
  const found = Object.entries(p.facts).filter(([k, f]) => (k === 'commands' ? Object.values(f).some((x) => !notFound(x)) : !notFound(f))).map(([k]) => k);
  assert(found.sort().join() === 'protectedBranchCandidates,remoteHost', `found facts: ${found.join(', ')}`);
  assert(Object.values(p.conventions).every(notFound), 'conventions found');
  assert(notFound(P.python?.facts.commands.build), 'python fixture has no build command, but one was recorded');
  return 'only the git facts found; python build not found';
});

step('conventions (A6): rules files, spec-kit, ADR folder, PR template and tracker, each with its path', () => {
  const t = P.ts.conventions, y = P.python.conventions;
  const paths = (c) => c.rulesFiles.value.map((r) => r.path).join(', ');
  assert(paths(t) === 'AGENTS.md, .cursor/rules' && paths(y) === 'CLAUDE.md', `rules files: ${paths(t)} / ${paths(y)}`);
  assert(y.specKit.path === '.specify' && t.adrs.path === 'docs/adr' && y.adrs.path === 'docs/decisions', 'spec-kit or ADRs');
  assert(t.prTemplate.path === '.github/pull_request_template.md' && y.prTemplate.path === '.gitlab/merge_request_templates', 'PR templates');
  assert(t.tracker.value === 'github-issues' && y.tracker.value === 'gitlab-issues', 'trackers');
  return 'AGENTS.md, CLAUDE.md, .cursor/rules, .specify, docs/adr, docs/decisions, both PR templates, both trackers';
});

step('SFRA (A1): SFRA flavour, Node pin, npm from its lockfile, exact commands, cartridges, branches, conventions', () => {
  const p = P.sfra; assert(p, 'no profile');
  assert(p.facts.platform.flavour === 'sfra' && p.facts.platform.source === 'package.json#paths.base', JSON.stringify(p.facts.platform));
  assert(p.facts.languages.value.map((l) => l.value).join() === 'JavaScript,ISML' && p.facts.node.value === '18.19.0', 'languages or Node');
  assert(p.facts.packageManager.value === 'npm' && p.facts.packageManager.source === 'package-lock.json', 'npm');
  assert(p.facts.commands.test.defined === 'sgmf-scripts --test test/unit/**/*.js' && p.facts.commands.build.run === 'npm run build' && notFound(p.facts.commands.lint), 'commands');
  assert(p.facts.layout.value.cartridges.join() === 'app_sample,int_sample_payments', 'cartridges');
  assert(p.facts.protectedBranchCandidates.value.join() === 'develop,main', 'protected-branch candidates');
  assert(p.conventions.prTemplate.path === '.github/pull_request_template.md' && p.conventions.rulesFiles.value[0].path === 'AGENTS.md', 'conventions');
  assert(p.suggestions.generated.some((g) => g.regenerate === 'npm run compile:js') && p.guidance.avoidSkills.includes('sfnext-*'), 'generated suggestion or guidance');
  return `${p.facts.platform.flavour}, cartridges ${p.facts.layout.value.cartridges.join(', ')}`;
});

// --- A7: secrets never appear --------------------------------------------------------------------------------
step('secrets (A7): credential files are never read and secret-looking values never appear in output or files', () => {
  const hex = (n) => randomBytes(n).toString('hex');
  const S = { token: 'gh' + 'p_' + hex(18), env: `envvalue${hex(8)}`, dw: `dwvalue${hex(8)}`, npm: `npmvalue${hex(8)}`, key: `keyvalue${hex(8)}` };
  const { dir } = project('ts', (d) => {
    put(d, '.env', `# DO NOT EDIT\nAPI_KEY=${S.env}\n`);
    put(d, 'dw.json', JSON.stringify({ _comment: '@generated', password: S.dw }) + '\n');
    put(d, '.npmrc', `# DO NOT EDIT\n//registry.npmjs.org/:_authToken=${S.npm}\n`);
    put(d, 'id_rsa', `# DO NOT EDIT\n${S.key}\n`);
    editJson(join(d, 'package.json'), (j) => { j.scripts.test = `GITHUB_TOKEN=${S.token} vitest run`; j.scripts.deploy = `npm publish --token ${S.token}`; });
  });
  let seen = '';
  const runAll = (a, extra) => { const r = profile(dir, a, extra); seen += r.stdout + r.stderr; return r; };
  runAll(['study']);
  for (const store of ['folder', 'agents-md', 'machine']) assert(runAll(['write', '--store', store, ...LISTS]).status === 0, `write ${store} failed`);
  for (const a of [['show'], ['diff'], ['check']]) runAll(a);
  const files = [join(dir, '.cartwright', 'profile.json'), join(dir, '.cartwright', 'settings.json'), join(dir, 'AGENTS.md')];
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of [...files, ...walk(STATE)]) seen += read(f);
  const leaked = Object.entries(S).filter(([, v]) => seen.includes(v)).map(([k]) => k);
  assert(!leaked.length, `secret values leaked: ${leaked.join(', ')}`);
  const p = readJson(files[0]);
  assert(p.facts.commands.test.defined === HIDDEN, `test command not hidden: ${p.facts.commands.test.defined}`);
  const sugg = p.suggestions.generated.map((g) => g.path);
  assert(!sugg.some((s) => /\.env|dw\.json|\.npmrc|id_rsa/.test(s)), `a credential file was searched: ${sugg.join(', ')}`);
  return `no value in ${files.length} files, the state folder or any output; test command shown as "${HIDDEN}"`;
});

// --- A8, A9: reproducible and read-only ----------------------------------------------------------------------
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else out[p] = `${s.mtimeMs}:${s.size}`; } };
  walk(dir);
  out.index = createHash('sha256').update(readFileSync(join(dir, '.git', 'index'))).digest('hex');
  return JSON.stringify(out);
}

step('read-only (A9): study, diff, show and check change no file, not even under .git, and write needs --store', () => {
  const { dir } = project('ts');
  const state = join(WORK, 'state-a9');
  const before = snapshot(dir);
  const s1 = profile(dir, ['study'], { CARTWRIGHT_STATE_DIR: state });
  assert(s1.status === 0, s1.stderr);
  for (const a of [['show'], ['check'], ['diff'], ['refresh']]) profile(dir, a, { CARTWRIGHT_STATE_DIR: state });
  const w = profile(dir, ['write'], { CARTWRIGHT_STATE_DIR: state });
  assert(w.status === 2 && /--store folder \(default\), agents-md or machine/.test(w.stderr), `write without --store: exit ${w.status} ${w.stderr.trim()}`);
  assert(snapshot(dir) === before, 'a file changed (mtime, size or the git index)');
  assert(clean(dir) && !existsSync(state), 'git status not clean, or something written to the state folder');
  return 'mtimes, sizes and .git/index unchanged; git status clean; nothing on the machine';
});

step('reads stay inside the project: a symlinked file pointing outside is never read', () => {
  const outside = join(WORK, 'outside-file'); mkdirSync(outside, { recursive: true });
  const marker = `outsidevalue${randomBytes(6).toString('hex')}`;
  writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: marker, scripts: { test: `echo ${marker}` } }) + '\n');
  const { dir } = project('unknown-stack');
  symlinkSync(join(outside, 'package.json'), join(dir, 'package.json'));
  const r = profile(dir, ['study']);
  assert(r.status === 0 && !r.stdout.includes(marker), 'a file outside the project was read through a symlink');
  assert(notFound(JSON.parse(r.stdout).profile.facts.commands.test), 'a command came from outside the project');
  return 'not read; test command not found';
});

step('reads stay inside the project: listing never enters a symlinked folder, or one that leads outside', () => {
  const outside = join(WORK, 'outside-dir', 'app_elsewhere', 'cartridge', 'controllers'); mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'Secret.js'), '\n');
  const { dir } = project('ts');
  symlinkSync(join(WORK, 'outside-dir'), join(dir, 'cartridges'));
  symlinkSync(join(WORK, 'outside-dir'), join(dir, 'docs', 'linked'));
  const ctx = makeCtx(dir);
  assert(ctx.list('cartridges', { depth: 3 }).length === 0, `listed a folder outside the project: ${ctx.list('cartridges', { depth: 3 })}`);
  const all = ctx.list('.', { depth: 4 });
  assert(all.includes('docs/linked') && !all.some((e) => e.startsWith('docs/linked/')), `entered a symlinked folder: ${all.filter((e) => e.startsWith('docs/linked')).join(', ')}`);
  assert(notFound(ok(dir, ['study']).profile.facts.platform), 'a cartridge outside the project made it SFCC');
  return 'cartridges (a link outside) lists nothing; docs/linked listed but not entered';
});

step('reproducible (A8): writing again with nothing changed changes no byte, and study gives the same output', () => {
  const { dir } = project('storefront-next');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  commitAll(dir, 'profile');
  const again = ok(dir, ['write', '--store', 'folder', ...LISTS]);
  assert(again.changed.length === 0 && clean(dir), `second write changed ${again.changed.join(', ')}`);
  assert(profile(dir, ['study']).stdout === profile(dir, ['study']).stdout, 'study output differs between runs');
  const text = read(join(dir, '.cartwright', 'profile.json'));
  assert(!text.includes(WORK) && !/\d{4}-\d{2}-\d{2}T\d{2}:/.test(text), 'absolute path or timestamp in the profile');
  return 'git diff empty; no paths or timestamps';
});

// --- A10, A11: drift and refresh -----------------------------------------------------------------------------
step('drift (A10): a changed test script is reported, again in the next session, and not after a refresh', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  commitAll(dir, 'profile');
  editJson(join(dir, 'package.json'), (j) => { j.scripts.test = 'vitest run --coverage'; });
  for (const session of [1, 2]) {
    const r = profile(dir, ['check']);
    const c = JSON.parse(r.stdout);
    assert(r.status === 1 && !c.upToDate && c.changed.join() === 'facts.commands.test', `session ${session}: exit ${r.status} ${JSON.stringify(c)}`);
  }
  ok(dir, ['refresh']);
  const r = profile(dir, ['check']);
  assert(r.status === 0 && JSON.parse(r.stdout).upToDate, `after refresh: ${r.stdout}`);
  return 'facts.commands.test reported twice, then up to date';
});

step('drift (A10): a new lockfile is reported (npm → pnpm)', () => {
  const { dir } = project('sfra');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  put(dir, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  const c = JSON.parse(profile(dir, ['check']).stdout);
  assert(c.changed.includes('facts.packageManager') && c.changed.includes('facts.commands.test'), JSON.stringify(c.changed));
  return c.changed.join(', ');
});

step('refresh (A11): diff lists exactly the changed facts; refresh writes only those, and leaves the settings alone', () => {
  const { dir } = project('python');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  rmSync(join(dir, '.cartwright', 'README.md'));
  commitAll(dir, 'profile');
  const settingsBefore = read(join(dir, '.cartwright', 'settings.json'));
  const before = readJson(join(dir, '.cartwright', 'profile.json'));
  put(dir, 'Makefile', `${read(join(dir, 'Makefile'))}\ntest:\n\tuv run pytest -q\n`);
  const d = ok(dir, ['diff']);
  const keys = d.changed.map((c) => c.key);
  assert(keys.join() === 'facts.commands.test,facts.otherScripts' || keys.join() === 'facts.commands.test', `diff: ${keys.join(', ')}`);
  assert(d.changed[0].before.run === 'uv run pytest' && d.changed[0].after.run === 'make test', 'before/after');
  const r = ok(dir, ['refresh']);
  assert(JSON.stringify(r.facts) === JSON.stringify(keys) && r.changed.join() === '.cartwright/profile.json', JSON.stringify(r));
  const after = readJson(join(dir, '.cartwright', 'profile.json'));
  after.facts.commands.test = before.facts.commands.test;
  after.facts.otherScripts = before.facts.otherScripts;
  assert(JSON.stringify(after) === JSON.stringify(before), 'refresh changed more than the listed facts');
  assert(read(join(dir, '.cartwright', 'settings.json')) === settingsBefore && !existsSync(join(dir, '.cartwright', 'README.md')), 'settings or other folder files changed');
  assert(git(dir, 'log', '--oneline').trim().split('\n').length === 2, 'refresh committed');
  // AGENTS.md mode: only the profile block changes; the settings block keeps its exact bytes, even hand-formatted.
  const a = project('python').dir;
  ok(a, ['write', '--store', 'agents-md', ...LISTS]);
  const settingsBlock = (t) => t.slice(t.indexOf('```json cartwright-settings'), t.indexOf('<!-- cartwright:end'));
  writeFileSync(join(a, 'AGENTS.md'), read(join(a, 'AGENTS.md')).replace('"rules": []', '"rules":   []'));
  const handEdited = settingsBlock(read(join(a, 'AGENTS.md')));
  put(a, 'Makefile', `${read(join(a, 'Makefile'))}\ntest:\n\tuv run pytest -q\n`);
  assert(ok(a, ['refresh']).facts.join() === keys.join(), 'agents-md refresh listed other facts');
  const now = read(join(a, 'AGENTS.md'));
  assert(settingsBlock(now) === handEdited && now.includes('"run": "make test"'), 'settings block rewritten, or profile not refreshed');
  return `${keys.join(', ')}; nothing committed; settings untouched in both modes`;
});

// --- B16, B17, B20: settings content, the personal file, the storage choices -------------------------------
step('settings content (B16): confirmed branches, the four rules on, generated files with commands, locations, tracks', () => {
  const { dir } = project('ts');
  const proposal = ok(dir, ['study']).proposedSettings;
  assert(proposal.protectedBranches.join() === 'develop,main', `proposed branches: ${proposal.protectedBranches}`);
  ok(dir, ['write', '--store', 'folder', '--protected', 'main,develop,release/*', '--generated', 'src/generated/**=pnpm generate:api',
    '--secrets-allow', 'tests/fixtures/**', '--allow-location', '~/sandbox', '--protect-location', '${HOME}/.ssh', '--client-project', 'no']);
  const s = readJson(join(dir, '.cartwright', 'settings.json'));
  assert(s.cartwright === 'settings' && s.version === 1, 'kind or version');
  assert(s.protectedBranches.join() === 'main,develop,release/*', `branches: ${s.protectedBranches}`);
  assert(Object.values(s.guardrails).length === 4 && Object.values(s.guardrails).every((v) => v === true), JSON.stringify(s.guardrails));
  assert(s.generated.length === 1 && s.generated[0].regenerate === 'pnpm generate:api', JSON.stringify(s.generated));
  assert(s.secrets.allow.join() === 'tests/fixtures/**', JSON.stringify(s.secrets));
  assert(s.locations.allowed.join() === '~/sandbox' && s.locations.protected.join() === '${HOME}/.ssh', JSON.stringify(s.locations));
  assert(s.tracks.enabled === false && /no effect yet/.test(s.tracks.$comment) && s.clientProject === false, JSON.stringify(s.tracks));
  assert(validateSettings(s).ok, 'the written settings are not valid');
  return 'all present';
});

step('settings need explicit lists (B16): new settings refuse to guess and print the proposal as the command to confirm', () => {
  // Storefront Next: the refusal shows a command that, run as shown, saves exactly the proposal.
  const sn = project('storefront-next').dir;
  const r = profile(sn, ['write', '--store', 'folder']);
  const cmd = (r.stderr.match(/^ {2}(node .*)$/m) || [])[1];
  assert(r.status === 2 && /--protected and --generated/.test(r.stderr) && cmd, `exit ${r.status}: ${r.stderr.trim()}`);
  assert(!existsSync(join(sn, '.cartwright')), 'something was written');
  assert(sh('/bin/sh', ['-c', cmd.replace(/^node /, `"${NODE}" `)], { cwd: sn, env: env() }).status === 0, `the printed command failed: ${cmd}`);
  const s = readJson(join(sn, '.cartwright', 'settings.json'));
  assert(s.protectedBranches.join() === 'develop,main' && s.generated.map((g) => `${g.path}=${g.regenerate}`).join() === 'cartridges/app_storefrontnext_base/cartridge/experience/**=pnpm cartridge:generate', JSON.stringify(s));
  // TypeScript: a suggestion with no known regenerate command is named, not dropped silently.
  const ts = project('ts').dir;
  const t = profile(ts, ['write', '--store', 'folder', '--protected', 'main']);
  assert(t.status === 2 && t.stderr.includes('src/generated/api.ts'), `suggestion without a command not mentioned: ${t.stderr.trim()}`);
  assert(ok(ts, ['study']).writeCommand?.includes('--generated none'), 'study has no write command');
  // Existing settings: an omitted list keeps the saved one; none empties a list; unknown rule switches survive.
  ok(ts, ['write', '--store', 'folder', '--protected', 'main', '--generated', 'src/generated/**=pnpm generate:api', '--secrets-allow', 'tests/fixtures/**', '--allow-location', '/opt/sandbox']);
  editJson(join(ts, '.cartwright', 'settings.json'), (x) => { x.guardrails['future-rule'] = true; });
  ok(ts, ['write', '--store', 'folder', '--protected', 'main,develop', '--allow-location', 'none']);
  const k = readJson(join(ts, '.cartwright', 'settings.json'));
  assert(k.protectedBranches.join() === 'main,develop' && k.generated[0]?.regenerate === 'pnpm generate:api' && k.secrets.allow.join() === 'tests/fixtures/**', `kept lists: ${JSON.stringify(k)}`);
  assert(!k.locations.allowed.length && k.guardrails['future-rule'] === true, `none or the unknown rule switch: ${JSON.stringify(k)}`);
  const old = profile(ts, ['write', '--store', 'folder', '--allow', '/tmp']);
  assert(old.status === 2 && /--allow-location/.test(old.stderr), `an unknown option was accepted: ${old.stderr.trim()}`);
  return 'refused with a runnable command; uncommanded suggestion named; omitted lists kept; none empties; future-rule kept; old flag refused';
});

step('personal file (B17): .cartwright/.gitignore ignores it, so git never offers it for commit', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  put(dir, '.cartwright/personal.json', JSON.stringify({ cartwright: 'personal', version: 1, protectedBranches: ['staging'] }) + '\n');
  assert(sh('git', ['check-ignore', '-q', '.cartwright/personal.json'], { cwd: dir, env: env() }).status === 0, 'not ignored');
  const status = git(dir, 'status', '--porcelain', '--untracked-files=all');
  assert(!status.includes('personal.json') && status.includes('.cartwright/.gitignore'), status);
  assert(read(join(dir, '.cartwright', '.gitignore')).includes('personal.json'), 'gitignore content');
  assert(!existsSync(join(dir, '.gitignore')), "the project's own .gitignore was created or changed");
  return 'check-ignore: ignored; git status lists the folder without it';
});

step('personal file (B18): it adds or tightens for this developer only; a teammate\'s clone is unaffected', () => {
  const { dir, bare } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  editJson(join(dir, '.cartwright', 'settings.json'), (s) => { s.guardrails['generated-files'] = false; });
  commitAll(dir, 'profile'); git(dir, 'push', '-q', 'origin', 'main');
  put(dir, '.cartwright/personal.json', JSON.stringify({ cartwright: 'personal', version: 1, guardrails: { 'generated-files': true },
    protectedBranches: ['staging'], generated: [{ path: 'dist/**', regenerate: 'pnpm build' }], locations: { protected: ['~/work'] },
    rules: [{ id: 'no-force-push', shell: 'git\\s+push\\s+.*--force', message: 'I never force-push.' }], preferences: { tone: 'brief' } }) + '\n');
  const me = ok(dir, ['show']).settings;
  const e = me.effective;
  assert(me.status === 'ok' && !me.loosening.length, JSON.stringify(me));
  assert(e.guardrails['generated-files'] === true && e.protectedBranches.includes('staging') && e.protectedBranches.includes('main'), 'tightening not applied');
  assert(e.generated.some((g) => g.path === 'dist/**') && e.locations.protected.includes('~/work') && e.rules.some((r) => r.id === 'no-force-push'), 'additions missing');
  const mate = ok(clone(bare, 'teammate'), ['show']).settings.effective;
  assert(mate.guardrails['generated-files'] === false && !mate.protectedBranches.includes('staging') && !mate.rules.length, 'teammate affected');
  return 'rule switched on, branch, generated path, location and rule added for me; teammate unchanged';
});

step('personal file (B19): attempts to switch off or loosen a team rule are ignored and reported', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', '--protected', 'develop,main', '--generated', 'src/generated/**=pnpm generate:api']);
  editJson(join(dir, '.cartwright', 'settings.json'), (s) => { s.rules = [{ id: 'no-prod-deploy', shell: 'deploy\\s+--prod', message: 'Production deploys go through the pipeline.' }]; });
  put(dir, '.cartwright/personal.json', JSON.stringify({ cartwright: 'personal', version: 1, guardrails: { secrets: false, 'protected-branches': false },
    protectedBranches: [], locations: { allowed: ['/'] }, secrets: { allow: ['**'] }, generated: [{ path: 'src/generated/**', regenerate: 'echo skip' }],
    rules: [{ id: 'no-prod-deploy', paths: ['nothing/**'], message: 'replaced' }], tracks: { enabled: true } }) + '\n');
  const s = ok(dir, ['show']).settings;
  const e = s.effective;
  assert(e.guardrails.secrets && e.guardrails['protected-branches'] && e.protectedBranches.join() === 'develop,main', 'a rule was loosened');
  assert(!e.locations.allowed.length && !e.secrets.allow.length && e.generated[0].regenerate === 'pnpm generate:api' && e.rules[0].message.startsWith('Production'), 'a list was loosened');
  const said = s.loosening.join('\n');
  for (const k of ['guardrails.secrets', 'guardrails.protected-branches', 'locations.allowed', 'secrets.allow', 'rules.no-prod-deploy', 'tracks']) assert(said.includes(k), `not reported: ${k}`);
  assert(/can only add or tighten/.test(said), 'the message doesn\'t say the personal file can only tighten');
  return `${s.loosening.length} attempts reported, team rules unchanged`;
});

step('storage (B20): each of the three choices works and is found again', () => {
  const out = [];
  for (const store of ['folder', 'agents-md', 'machine']) {
    const { dir } = project('python');
    ok(dir, ['write', '--store', store, ...LISTS]);
    const s = ok(dir, ['show']);
    assert(s.store === store && s.profile?.facts.python.value === '3.12.7' && s.settings.status === 'ok', `${store}: ${JSON.stringify({ store: s.store, settings: s.settings.status })}`);
    const leftovers = [join(dir, '.cartwright'), STATE].filter(existsSync).flatMap((d) => readdirSync(d, { recursive: true })).filter((f) => String(f).endsWith('.tmp'));
    assert(!leftovers.length, `temporary files left: ${leftovers.join(', ')}`);
    out.push(store);
  }
  return out.join(', ') + '; no temporary files left';
});

step('storage (B21): AGENTS.md mode adds one marked section, keeps every other byte, and creates no .cartwright/', () => {
  const { dir } = project('ts');
  const original = read(join(dir, 'AGENTS.md'));
  const w = ok(dir, ['write', '--store', 'agents-md', ...LISTS]);
  const text = read(join(dir, 'AGENTS.md'));
  assert(w.changed.join() === 'AGENTS.md' && !existsSync(join(dir, '.cartwright')), `changed ${w.changed}; .cartwright exists: ${existsSync(join(dir, '.cartwright'))}`);
  assert(text.startsWith(original) && text.slice(original.length).startsWith('\n<!-- cartwright:begin'), 'bytes before the section changed, or no blank line before it');
  assert(ok(dir, ['write', '--store', 'agents-md', ...LISTS]).changed.length === 0, 'second write changed it');
  // Text the team adds around the section stays exactly as it is when the section is rewritten.
  writeFileSync(join(dir, 'AGENTS.md'), `# Top\r\n\r\n${text}\r\nAfter the section.`);
  const around = read(join(dir, 'AGENTS.md'));
  ok(dir, ['write', '--store', 'agents-md', '--protected', 'main']);
  const now = read(join(dir, 'AGENTS.md'));
  const cut = (t) => [t.slice(0, t.indexOf('<!-- cartwright:begin')), t.slice(t.indexOf('<!-- cartwright:end -->') + '<!-- cartwright:end -->'.length)];
  assert(JSON.stringify(cut(now)) === JSON.stringify(cut(around)), 'bytes outside the markers changed');
  assert(ok(dir, ['show']).settings.effective.protectedBranches.join() === 'main', 'the section\'s settings are not the ones that apply');
  // No AGENTS.md: it's created with only the section.
  const u = project('unknown-stack').dir;
  ok(u, ['write', '--store', 'agents-md', ...LISTS]);
  assert(read(join(u, 'AGENTS.md')).startsWith('<!-- cartwright:begin') && !existsSync(join(u, '.cartwright')), 'AGENTS.md not created with only the section');
  assert(profile(u, ['check']).status === 0 && ok(u, ['show']).profile.conventions.rulesFiles.value[0].path === 'AGENTS.md', 'the profile is stale right after creating AGENTS.md');
  // Markers missing a partner: write refuses and changes nothing; the settings count as broken.
  writeFileSync(join(u, 'AGENTS.md'), read(join(u, 'AGENTS.md')).replace('<!-- cartwright:end -->', ''));
  const broken = read(join(u, 'AGENTS.md'));
  assert(profile(u, ['write', '--store', 'agents-md', ...LISTS]).status === 1 && read(join(u, 'AGENTS.md')) === broken, 'wrote over unpaired markers');
  assert(ok(u, ['show']).settings.status === 'broken', 'unpaired markers not treated as broken settings');
  return 'section appended after one blank line; CRLF text around it untouched; idempotent; created when missing';
});

step('storage (B22): machine mode changes nothing in the repo, and another clone is unprofiled', () => {
  const { dir, bare } = project('ts');
  const w = ok(dir, ['write', '--store', 'machine', ...LISTS]);
  assert(clean(dir) && w.changed.every((p) => p.startsWith(STATE)), `repo changed: ${git(dir, 'status', '--porcelain')}`);
  assert(w.changed.some((p) => p.endsWith('settings.json')) && w.changed.some((p) => p.endsWith('/root')), w.changed.join(', '));
  assert(ok(dir, ['show']).store === 'machine', 'not found again');
  const mate = ok(clone(bare, 'teammate'), ['show']);
  assert(mate.store === null && mate.profile === null && mate.settings.status === 'none', JSON.stringify(mate));
  return 'git status clean; teammate\'s clone has no profile';
});

step('lookup order: the folder wins over the machine copy, and both are reported', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'machine', ...LISTS]);
  const w = ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const s = ok(dir, ['show']);
  assert(s.store === 'folder' && s.found.join() === 'folder,machine' && w.otherStores.join() === 'machine' && !w.active, JSON.stringify({ store: s.store, found: s.found, other: w.otherStores, active: w.active }));
  const a = ok(dir, ['write', '--store', 'agents-md', ...LISTS]);
  assert(a.active === 'folder' && /\.cartwright\/ folder still takes precedence; remove it to use the AGENTS\.md section/.test(a.note), JSON.stringify(a));
  return `folder, agents-md, machine; "${a.note}"`;
});

// --- broken settings: fail safe, loud, and never quoting the file -------------------------------------------
step('broken settings: malformed, newer version or a schema error all fail safe and say where, never what', () => {
  const { dir } = project('storefront-next');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const file = join(dir, '.cartwright', 'settings.json');
  const marker = `markervalue${randomBytes(6).toString('hex')}`;
  const cases = [
    ['malformed', `{\n  "cartwright": "settings",\n  "version": 1,\n  "protectedBranches": ["${marker}"\n`, /not valid JSON/],
    ['newer version', JSON.stringify({ cartwright: 'settings', version: 2, note: marker }), /needs a newer Cartwright/],
    ['schema error', JSON.stringify({ cartwright: 'settings', version: 1, protectedBranches: marker, rules: [{ id: 'x', shell: '(', message: marker }] }), /protectedBranches: must be a list.*rules\[0\]\.shell/],
  ];
  for (const [name, text, expect] of cases) {
    writeFileSync(file, text);
    const r = profile(dir, ['show']);
    const s = JSON.parse(r.stdout).settings;
    assert(s.status === 'broken' && expect.test(s.message) && s.message.includes('.cartwright/settings.json'), `${name}: ${s.message}`);
    assert(!r.stdout.includes(marker), `${name}: the file's content was quoted`);
    const e = s.effective;
    assert(Object.values(e.guardrails).every(Boolean) && e.protectedBranches.join() === 'main,develop', `${name}: defaults not applied`);
    assert(e.generated.some((g) => g.regenerate === 'pnpm cartridge:generate') && !e.rules.length && !e.locations.allowed.length, `${name}: fallback lists`);
    assert(profile(dir, ['check']).status === 1, `${name}: check passed`);
    assert(profile(dir, ['write', '--store', 'folder', ...LISTS]).status === 1 && read(file) === text, `${name}: write overwrote the broken file`);
  }
  writeFileSync(file, JSON.stringify({ cartwright: 'settings', version: 1, laterKey: true }));
  const later = ok(dir, ['show']).settings;
  assert(later.status === 'ok' && later.warnings.some((w) => w.includes('laterKey')), 'an unknown top-level key should only warn');
  return 'all three: rules on, main/develop + the profile\'s generated suggestions, extras paused; unknown keys only warn';
});

step('merge rules: isTightening agrees with the table', () => {
  const base = teamDefaults(validateSettings({ cartwright: 'settings', version: 1, protectedBranches: ['main'], locations: { allowed: ['/opt/x'] } }).value);
  const tighter = teamDefaults(validateSettings({ cartwright: 'settings', version: 1, protectedBranches: ['main', 'develop'], locations: { allowed: [] } }).value);
  const looser = teamDefaults(validateSettings({ cartwright: 'settings', version: 1, guardrails: { secrets: false }, protectedBranches: ['main'], locations: { allowed: ['/opt/x'] } }).value);
  assert(isTightening(base, tighter) && !isTightening(tighter, base) && !isTightening(base, looser), 'wrong verdict');
  const team = (extra) => teamDefaults(validateSettings({ cartwright: 'settings', version: 1, ...extra }).value);
  const full = { secrets: { allow: ['tests/fixtures/**'] }, rules: [{ id: 'no-prod', shell: 'deploy --prod', message: 'Use the pipeline.' }],
    generated: [{ path: 'INDEX.md', regenerate: 'npm run build' }], locations: { protected: ['~/.ssh'] } };
  const cases = {
    'secrets.allow widened': { ...full, secrets: { allow: ['tests/fixtures/**', '**'] } },
    'a team rule removed': { ...full, rules: [] },
    'a generated path removed': { ...full, generated: [] },
    'a protected location removed': { ...full, locations: { protected: [] } },
  };
  for (const [name, after] of Object.entries(cases)) assert(!isTightening(team(full), team(after)), `${name} counted as tightening`);
  assert(isTightening(team(full), team(full)), 'unchanged settings should count as at least as strict');
  return 'tighter: yes; reversed, a rule off, secrets.allow widened, a rule, generated path or protected location removed: no';
});

step('outside a git repository: a clear message and exit 2', () => {
  const d = join(WORK, 'not-a-repo'); mkdirSync(d);
  const r = profile(d, ['study']);
  assert(r.status === 2 && /Not a git repository/.test(r.stderr), `exit ${r.status}: ${r.stderr}`);
  return r.stderr.trim();
});

if (!KEEP) rmSync(STATE, { recursive: true, force: true });
process.exit(report('Cartwright profile test', { keep: KEEP }));
