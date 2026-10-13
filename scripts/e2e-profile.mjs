#!/usr/bin/env node
// Deterministic test of the project profiler and its files, against a copy of the built plugin only: the fixture
// projects in tests/projects/ are turned into git repos (with a local bare remote) in a throwaway folder, profiled,
// and compared with their expected profiles in tests/expected/. Covers detection and "not found", secrets never
// leaking, reproducible output, read-only study, drift and refresh, the settings content, the personal file and
// its merge rules, the three storage modes, and broken settings. Offline; no agents; free.
//
// Usage: node scripts/e2e-profile.mjs [--plugin ./plugin] [--keep] [--update-goldens] [--no-timing | --timing-only]
//   --update-goldens   rewrite tests/expected/*.profile.json from this run (review the diff before committing)
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, halfTheCpus, harness, json, sh } from './e2e-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const KEEP = args.includes('--keep');
const UPDATE = args.includes('--update-goldens');
const { WORK, HOME, BARE, step, report } = harness('cartwright-profile-', { concurrency: halfTheCpus() });
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
// Each fixture's written profile, made once per test process (steps may run in different processes).
const PROFILES = {};
function written(name) {
  if (PROFILES[name] === undefined) {
    const { dir } = project(name);
    const w = ok(dir, ['write', '--store', 'folder', ...LISTS]);
    assert(w.changed.includes('.cartwright/profile.json'), `nothing written: ${JSON.stringify(w)}`);
    PROFILES[name] = read(join(dir, '.cartwright', 'profile.json'));
  }
  return PROFILES[name];
}
const P = new Proxy({}, { get: (_, name) => (FIXTURES.includes(name) ? JSON.parse(written(name)) : undefined) });
for (const name of FIXTURES) {
  step(`${name}: the profile matches tests/expected/${name}.profile.json, every fact with its source`, () => {
    const got = written(name);
    const golden = join(ROOT, 'tests', 'expected', `${name}.profile.json`);
    if (UPDATE) { mkdirSync(dirname(golden), { recursive: true }); writeFileSync(golden, got); }
    assert(existsSync(golden), `no expected profile; run with --update-goldens and review it`);
    assert(got === read(golden), `differs from the expected profile (run with --update-goldens and review the diff)`);
    const bad = unsourced(JSON.parse(got));
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
  assert(p.facts.commands.build.run === 'npm run build' && p.facts.commands.build.defined === 'npm run compile:js && npm run compile:scss', `build: ${JSON.stringify(p.facts.commands.build)}`);
  assert(p.facts.commands.test.run === 'npm test' && p.facts.commands.test.defined === 'sgmf-scripts --test test/unit/**/*.js' && notFound(p.facts.commands.lint), 'test or lint');
  assert(p.facts.layout.value.cartridges.join() === 'app_sample,int_sample_payments', 'cartridges');
  assert(p.facts.protectedBranchCandidates.value.join() === 'develop,main', 'protected-branch candidates');
  assert(p.conventions.prTemplate.path === '.github/pull_request_template.md' && p.conventions.rulesFiles.value[0].path === 'AGENTS.md', 'conventions');
  assert(p.suggestions.generated.some((g) => g.regenerate === 'npm run compile:js') && p.guidance.avoidSkills.includes('sfnext-*'), 'generated suggestion or guidance');
  return `${p.facts.platform.flavour}, cartridges ${p.facts.layout.value.cartridges.join(', ')}`;
});

// --- A7: secrets never appear --------------------------------------------------------------------------------
step('secrets (A7): credential files are never read and secret-looking values never appear in output or files', () => {
  const hex = (n) => randomBytes(n).toString('hex');
  const S = { token: 'gh' + 'p_' + hex(18), env: `envvalue${hex(8)}`, dw: `dwvalue${hex(8)}`, npm: `npmvalue${hex(8)}`, key: `keyvalue${hex(8)}`,
    urlpass: `Pa55${hex(6)}`, bearer: `bearer${hex(10)}`, stripe: `sk_live_${hex(10)}`, mysql: `S3cr${hex(5)}`, pyurl: `pyPa55${hex(6)}` };
  const CRED_FILES = ['id_ed25519', 'id_ecdsa', 'id_dsa', 'release.jks', 'app.keystore', '.pgpass', 'secrets.yaml', 'prod.tfvars'];
  const { dir } = project('ts', (d) => {
    put(d, '.env', `# DO NOT EDIT\nAPI_KEY=${S.env}\n`);
    put(d, 'dw.json', JSON.stringify({ _comment: '@generated', password: S.dw }) + '\n');
    put(d, '.npmrc', `# DO NOT EDIT\n//registry.npmjs.org/:_authToken=${S.npm}\n`);
    put(d, 'id_rsa', `# DO NOT EDIT\n${S.key}\n`);
    CRED_FILES.forEach((f, i) => put(d, f, `# DO NOT EDIT\ncredvalue${i}${S.key}\n`));
    // Values in files the profiler does read, in the shapes people actually paste into scripts.
    editJson(join(d, 'package.json'), (j) => {
      j.scripts.test = `GITHUB_TOKEN=${S.token} vitest run`;
      j.scripts.build = `psql postgres://admin:${S.urlpass}@db.internal/app -c 'select 1' && tsc -p tsconfig.json`;
      j.scripts.lint = `curl -H "Authorization: Bearer ${S.bearer}" https://lint.example.com && API_KEY=${S.stripe} eslint . && mysql -p${S.mysql} -e 'select 1'`;
      j.scripts.deploy = `npm publish --token ${S.token}`;
    });
    put(d, 'pyproject.toml', `[project]\nname = "x"\nrequires-python = "postgres://u:${S.pyurl}@h"\n`);
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
  for (const c of ['test', 'build', 'lint']) assert(p.facts.commands[c].defined === HIDDEN, `${c} command not hidden: ${p.facts.commands[c].defined}`);
  const sugg = p.suggestions.generated.map((g) => g.path);
  assert(!sugg.some((s) => /\.env|dw\.json|\.npmrc|id_|\.jks|\.keystore|\.pgpass|secrets\.|\.tfvars/.test(s)), `a credential file was searched: ${sugg.join(', ')}`);
  return `no value in ${files.length} files, the state folder or any output (URL password, Bearer, sk_live_, mysql -p, ${CRED_FILES.length + 4} credential files); commands shown as "${HIDDEN}"`;
});

step('secrets (A7): each secret shape in a script is hidden, and ordinary scripts are not', () => {
  const hex = (n) => randomBytes(n).toString('hex');
  const v = () => `v${hex(6)}`;
  const hide = [
    () => `API_KEY="${v()}" node x`, () => `TOKEN='${v()}' node x`, () => `npm publish --token ${v()}`, () => `psql --password ${v()}`,
    () => `docker login -p ${v()} registry`, () => `sshpass -p ${v()} ssh host`, () => `redis-cli -a ${v()} ping`,
    () => `curl -u admin:${v()} https://example.com`, () => `curl -H "Authorization: Basic ${Buffer.from(v()).toString('base64')}" x`,
    () => `aws_secret_access_key = ${hex(12)}abcdefgh`, () => `curl https://hooks.slack.com/services/T0/B0/${hex(8)}`,
    () => `SENTRY_DSN=https://${hex(16)}@o1.ingest.sentry.io/123 node x`, () => `echo sk_${'test'}_${hex(8)}`, () => `echo glpat-${hex(12)}`,
    () => `AUTH="Basic ${Buffer.from(`admin:${v()}`).toString('base64')}" node x`, () => `node report.js --dsn https://${hex(16)}@sentry.example.com`,
    () => `SENTRY_DSN=https://a1${hex(5)}@o1.ingest.sentry.io/1 x`,
  ];
  const keep = ['jest --passWithNoTests', 'eslint --max-warnings=0 .', 'PASSWORD_MIN_LENGTH=12 node x', 'KEYCLOAK_URL=http://localhost:8080 node x', 'npm publish --token $NPM_TOKEN'];
  const { dir } = project('ts');
  const testOf = (script) => { editJson(join(dir, 'package.json'), (j) => { j.scripts.test = script; }); return ok(dir, ['study']).profile.facts.commands.test.defined; };
  const shown = hide.map((f) => f()).filter((script) => testOf(script) !== HIDDEN);
  assert(!shown.length, `shown as written: ${shown.length} of ${hide.length} shapes`);
  const hidden = keep.filter((script) => testOf(script) !== script);
  assert(!hidden.length, `ordinary scripts hidden: ${hidden.join(' | ')}`);
  return `${hide.length} shapes hidden; ${keep.length} ordinary scripts kept`;
});

// --- A8, A9: reproducible and read-only ----------------------------------------------------------------------
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else out[p] = `${s.mtimeMs}:${s.size}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`; } };
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
  // A profiled project whose index is stale (files touched since it was written): git would normally refresh the
  // index; diff, check, refresh, show and study must leave the tree and .git byte for byte as they were.
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  commitAll(dir, 'profile');
  const later = new Date(Date.now() + 60000);
  for (const f of ['package.json', 'tsconfig.json', 'src/server.ts', '.cartwright/profile.json']) utimesSync(join(dir, f), later, later);
  const stale = snapshot(dir);
  for (const a of [['diff'], ['check'], ['refresh'], ['show'], ['study']]) assert(profile(dir, a).status === 0, `${a[0]} failed`);
  assert(snapshot(dir) === stale, 'a file or .git changed on a profiled project with a stale index');
  return 'unprofiled and profiled (stale index): every file and .git byte for byte unchanged; nothing on the machine';
});

step('reads stay inside the project: a symlinked .nvmrc pointing outside is never read, and a pin must look like one', () => {
  const marker = `DB_PASS=outside${randomBytes(6).toString('hex')}`;
  const { dir } = project('ts');
  writeFileSync(join(dir, '..', 'outside.env'), `${marker}\n`);
  rmSync(join(dir, '.nvmrc'));
  symlinkSync('../outside.env', join(dir, '.nvmrc'));
  const r = profile(dir, ['study']);
  assert(r.status === 0 && !r.stdout.includes(marker), 'a file outside the project was read through a symlink');
  assert(notFound(JSON.parse(r.stdout).profile.facts.node), `Node pin came from outside: ${JSON.stringify(JSON.parse(r.stdout).profile.facts.node)}`);
  // Inside the project, but not a version: "not found", not the text.
  rmSync(join(dir, '.nvmrc')); writeFileSync(join(dir, '.nvmrc'), 'DB_PASS=hunter2hunter2\n');
  const n = ok(dir, ['study']).profile.facts.node;
  assert(notFound(n), `a non-version pin was recorded: ${JSON.stringify(n)}`);
  // A symlink inside the project to a credential file: never opened, even though the target is inside.
  rmSync(join(dir, '.nvmrc'));
  // Version-shaped content, so it would show if the file were opened.
  writeFileSync(join(dir, '.env'), '20.99.1\n');
  symlinkSync('.env', join(dir, '.nvmrc'));
  const e = profile(dir, ['study']);
  assert(e.status === 0 && notFound(JSON.parse(e.stdout).profile.facts.node), `.nvmrc → .env was read: ${JSON.stringify(JSON.parse(e.stdout).profile.facts.node)}`);
  return 'not read; "DB_PASS=…" in .nvmrc is not a Node version; .nvmrc → .env inside the project not read either';
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
  assert(keys.join() === 'facts.commands.test', `diff: ${keys.join(', ')}`);
  assert(d.changed[0].before.run === 'uv run pytest' && d.changed[0].after.run === 'make test', 'before/after');
  const r = ok(dir, ['refresh']);
  assert(JSON.stringify(r.facts) === JSON.stringify(keys) && r.changed.join() === '.cartwright/profile.json', JSON.stringify(r));
  const after = readJson(join(dir, '.cartwright', 'profile.json'));
  after.facts.commands.test = before.facts.commands.test;
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

step('storage (B21): a symlinked AGENTS.md stays a symlink, and a link leading outside the project is refused', () => {
  const { dir } = project('ts', (d) => { writeFileSync(join(d, 'CLAUDE.md'), read(join(d, 'AGENTS.md'))); rmSync(join(d, 'AGENTS.md')); symlinkSync('CLAUDE.md', join(d, 'AGENTS.md')); });
  ok(dir, ['write', '--store', 'agents-md', ...LISTS]);
  assert(lstatSync(join(dir, 'AGENTS.md')).isSymbolicLink(), 'AGENTS.md was replaced by a plain file');
  assert(read(join(dir, 'CLAUDE.md')).includes('<!-- cartwright:begin'), 'the section did not land in CLAUDE.md');
  const status = git(dir, 'status', '--porcelain').trim();
  assert(status === 'M CLAUDE.md', `git status: ${status}`);
  const out = project('ts').dir;
  writeFileSync(join(out, '..', 'outside-agents.md'), '# outside\n');
  rmSync(join(out, 'AGENTS.md')); symlinkSync('../outside-agents.md', join(out, 'AGENTS.md'));
  const r = profile(out, ['write', '--store', 'agents-md', ...LISTS]);
  assert(r.status === 1 && /symlink to a file outside the project/.test(r.stderr) && read(join(out, '..', 'outside-agents.md')) === '# outside\n', `exit ${r.status}: ${r.stderr.trim()}`);
  return 'AGENTS.md → CLAUDE.md kept, section in CLAUDE.md, git status M CLAUDE.md; outside link refused';
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

step('exact names only: claude.md, PULL_REQUEST_TEMPLATE.md and docs/ADR give the same profile on any disk', () => {
  const { dir } = project('unknown-stack', (d) => {
    put(d, 'claude.md', '# lower-case rules file\n');
    put(d, '.github/PULL_REQUEST_TEMPLATE.md', '## What\n');
    put(d, 'docs/ADR/0001-x.md', '# 1. X\n');
  });
  const c = ok(dir, ['study']).profile.conventions;
  assert(notFound(c.rulesFiles), `claude.md counted as CLAUDE.md: ${JSON.stringify(c.rulesFiles)}`);
  assert(c.prTemplate.path === '.github/PULL_REQUEST_TEMPLATE.md', `PR template recorded as ${c.prTemplate.path}`);
  assert(notFound(c.adrs), `docs/ADR counted as docs/adr: ${JSON.stringify(c.adrs)}`);
  return 'rules files and ADRs not found; PR template under its own name';
});

step('AGENTS.md that only mentions the markers (in prose or a code block) is not Cartwright storage', () => {
  const prose = '# Rules\n\nCartwright keeps its section between `<!-- cartwright:begin` and `<!-- cartwright:end -->`.\n\n```md\n<!-- cartwright:begin. Example -->\n<!-- cartwright:end -->\n```\n';
  const { dir } = project('ts', (d) => put(d, 'AGENTS.md', prose));
  const s = ok(dir, ['show']);
  assert(s.store === null && s.settings.status === 'none', `treated as storage: ${JSON.stringify({ store: s.store, settings: s.settings.status })}`);
  ok(dir, ['write', '--store', 'agents-md', ...LISTS]);
  const text = read(join(dir, 'AGENTS.md'));
  assert(text.startsWith(prose) && ok(dir, ['show']).store === 'agents-md' && profile(dir, ['check']).status === 0, 'the section was not added after the prose');
  return 'unprofiled until written; then the real section is found and the prose kept';
});

step('AGENTS.md edge cases: BOM, CRLF without a final newline, mixed or CR-only endings, empty files', () => {
  const cases = {
    'crlf-no-final-newline': '﻿# Rules\r\n\r\nUse pnpm.\t \r\nTrailing ws   \r\nÜnïcödé — ok',
    'lf-final-newline': '# Rules\n\n- one\n- two\n',
    'mixed-endings': '# Rules\r\nline lf\nline crlf\r\n',
    'empty-file': '',
    'only-newline': '\n',
    'cr-only': '# Old Mac\rline\r',
  };
  const cut = (t) => [t.slice(0, t.indexOf('<!-- cartwright:begin')), t.slice(t.indexOf('<!-- cartwright:end -->') + '<!-- cartwright:end -->'.length)];
  const bad = [];
  for (const [name, orig] of Object.entries(cases)) {
    const { dir } = project('unknown-stack', (d) => put(d, 'AGENTS.md', orig));
    const w = profile(dir, ['write', '--store', 'agents-md', ...LISTS]);
    const t1 = read(join(dir, 'AGENTS.md'));
    writeFileSync(join(dir, 'AGENTS.md'), `Before\r\n${t1}\nAfter\n\n`);
    const around = read(join(dir, 'AGENTS.md'));
    profile(dir, ['write', '--store', 'agents-md', '--protected', 'main,release/*']);
    const t2 = read(join(dir, 'AGENTS.md'));
    profile(dir, ['write', '--store', 'agents-md', '--protected', 'main,release/*']);
    const ok1 = w.status === 0 && t1.startsWith(orig) && JSON.stringify(cut(t2)) === JSON.stringify(cut(around)) && read(join(dir, 'AGENTS.md')) === t2 && profile(dir, ['check']).status === 0;
    if (!ok1) bad.push(name);
  }
  assert(!bad.length, `failed: ${bad.join(', ')}`);
  return `${Object.keys(cases).length} cases: original kept, text around the section kept, idempotent, up to date`;
});

step('unreadable storage (D40, P5): an unreadable settings file or .cartwright/ folder is broken, never "unprofiled"', () => {
  if (process.getuid?.() === 0) return 'skipped: running as root, so file permissions don\'t stop reads';
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const file = join(dir, '.cartwright', 'settings.json'), folder = join(dir, '.cartwright');
  const results = [];
  for (const [name, target] of [['settings.json', file], ['the folder', folder]]) {
    chmodSync(target, 0o000);
    try {
      const s = ok(dir, ['show']);
      const w = profile(dir, ['write', '--store', 'folder', ...LISTS]);
      results.push([name, s.store === 'folder' && s.settings.status === 'broken' && /can't be read \(EACCES\)/.test(s.settings.message)
        && Object.values(s.settings.effective.guardrails).every(Boolean) && profile(dir, ['check']).status === 1
        && w.status === 1 && !/can't be read: the file can't be read|can't be read: can't be read/.test(w.stderr), s.settings.message]);
    } finally { chmodSync(target, target === folder ? 0o755 : 0o644); }
  }
  const bad = results.filter(([, good]) => !good);
  assert(!bad.length, bad.map(([n, , m]) => `${n}: ${m}`).join('; '));
  return 'both: broken, all rules on, check fails, write refuses with one clear message';
});

step('no unsourced defaults (A5, P8): no lockfile means no guessed npm; an engines range is recorded as a range', () => {
  const { dir } = project('unknown-stack', (d) => put(d, 'package.json', JSON.stringify({ name: 'x', engines: { node: '>=20' }, scripts: { build: 'node build.mjs', compile: 'node c.mjs' } }) + '\n'));
  const p = ok(dir, ['study']).profile;
  assert(notFound(p.facts.packageManager) && p.facts.commands.build.defined === 'node build.mjs' && p.facts.commands.build.run === undefined, `build: ${JSON.stringify(p.facts.commands.build)}`);
  assert(p.facts.node.value === '>=20' && p.facts.node.kind === 'range' && p.facts.node.source === 'package.json#engines.node', `node: ${JSON.stringify(p.facts.node)}`);
  assert(!JSON.stringify(p).includes('npm '), 'npm assumed somewhere');
  return 'build recorded as defined with no run command; Node >=20 (range)';
});

step('AGENTS.md: an unclosed code fence is refused; markers in an indented code block don\'t count', () => {
  const unclosed = '# Rules\n\n```sh\nnpm test\n';
  const { dir } = project('ts', (d) => put(d, 'AGENTS.md', unclosed));
  const r = profile(dir, ['write', '--store', 'agents-md', ...LISTS]);
  assert(r.status === 1 && /unclosed code fence at line 3; close it and run again/.test(r.stderr) && read(join(dir, 'AGENTS.md')) === unclosed, `exit ${r.status}: ${r.stderr.trim()}`);
  const indented = '# Rules\n\nAn example:\n\n    <!-- cartwright:begin. Example -->\n    <!-- cartwright:end -->\n';
  const i = project('ts', (d) => put(d, 'AGENTS.md', indented)).dir;
  assert(ok(i, ['show']).store === null, 'markers in an indented code block counted as storage');
  ok(i, ['write', '--store', 'agents-md', ...LISTS]);
  assert(read(join(i, 'AGENTS.md')).startsWith(indented) && profile(i, ['check']).status === 0 && ok(i, ['write', '--store', 'agents-md']).changed.length === 0, 'section not added after the indented example, or not idempotent');
  return 'unclosed fence: refused, file untouched; indented markers ignored, real section added once';
});

step('AGENTS.md exact name: with only Agents.md, Cartwright neither reads nor writes it, and says so', () => {
  const { dir } = project('ts', (d) => renameSync(join(d, 'AGENTS.md'), join(d, 'Agents.md')));
  const before = read(join(dir, 'Agents.md'));
  const r = profile(dir, ['write', '--store', 'agents-md', ...LISTS]);
  assert(r.status === 1 && /has Agents\.md, not AGENTS\.md/.test(r.stderr) && /git mv Agents\.md AGENTS\.md/.test(r.stderr), `exit ${r.status}: ${r.stderr.trim()}`);
  assert(read(join(dir, 'Agents.md')) === before, 'Agents.md was written');
  const s = ok(dir, ['show']);
  assert(s.store === null && s.notes?.some((n) => n.includes('Agents.md')), JSON.stringify({ store: s.store, notes: s.notes }));
  return 'write refused with the rename to make; show notes the mismatch';
});

step('unreadable AGENTS.md on its own: the project stays unprofiled (Q1), with a note', () => {
  if (process.getuid?.() === 0) return 'skipped: running as root, so file permissions don\'t stop reads';
  const { dir } = project('ts');
  const file = join(dir, 'AGENTS.md');
  chmodSync(file, 0o000);
  try {
    const s = ok(dir, ['show']);
    assert(s.store === null && s.settings.status === 'none' && s.notes?.some((n) => /AGENTS\.md can't be read/.test(n)), JSON.stringify({ store: s.store, settings: s.settings.status, notes: s.notes }));
    assert(profile(dir, ['check']).status === 0, 'check failed on an unprofiled project');
    assert(profile(dir, ['write', '--store', 'agents-md', ...LISTS]).status === 1, 'wrote over an unreadable AGENTS.md');
  } finally { chmodSync(file, 0o644); }
  return 'unprofiled with a note; write into it refused';
});

step('writes keep each file\'s mode (a 600 settings file stays 600)', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const file = join(dir, '.cartwright', 'settings.json');
  chmodSync(file, 0o600);
  const w = ok(dir, ['write', '--store', 'folder', '--protected', 'main']);
  const mode = statSync(file).mode & 0o777;
  assert(w.changed.includes('.cartwright/settings.json') && mode === 0o600, `mode ${mode.toString(8)} after ${JSON.stringify(w.changed)}`);
  return '600 kept';
});

step('profile and storage details: no settings, a folder link leading outside, floating Node pins, fences, truncated JSON', () => {
  // A profile with no guardrail settings: check exits 0 but says the profiled rules are off.
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  rmSync(join(dir, '.cartwright', 'settings.json'));
  const c = profile(dir, ['check']);
  assert(c.status === 0 && /no guardrail settings: the protected-branch and generated-file rules are off/.test(c.stdout), `check: exit ${c.status} ${c.stdout.slice(0, 200)}`);
  // A .cartwright folder that's a symlink leading outside the project is refused, and nothing is written there.
  const out = project('ts').dir, elsewhere = join(WORK, `elsewhere-${process.pid}`);
  mkdirSync(elsewhere, { recursive: true }); symlinkSync(elsewhere, join(out, '.cartwright'));
  const w = profile(out, ['write', '--store', 'folder', ...LISTS]);
  assert(w.status === 1 && /symlink to a folder outside the project/.test(w.stderr) && readdirSync(elsewhere).length === 0, `exit ${w.status}: ${w.stderr.trim()}`);
  // Floating Node pins are recorded as aliases, not pins.
  const lts = project('ts', (d) => put(d, '.nvmrc', 'lts/iron\n')).dir;
  const node = ok(lts, ['study']).profile.facts.node;
  assert(node.value === 'lts/iron' && node.kind === 'alias', JSON.stringify(node));
  // An unclosed fence after an existing section is refused too.
  const f = project('ts').dir;
  ok(f, ['write', '--store', 'agents-md', ...LISTS]);
  writeFileSync(join(f, 'AGENTS.md'), `${read(join(f, 'AGENTS.md'))}\n\`\`\`sh\nnpm test\n`);
  const r = profile(f, ['write', '--store', 'agents-md', '--protected', 'main']);
  assert(r.status === 1 && /unclosed code fence/.test(r.stderr), `exit ${r.status}: ${r.stderr.trim()}`);
  // Truncated settings say where they end.
  const t = project('ts').dir;
  ok(t, ['write', '--store', 'folder', ...LISTS]);
  writeFileSync(join(t, '.cartwright', 'settings.json'), '{ "cartwright": "settings", "version": 1, "rules": [');
  const msg = ok(t, ['show']).settings.message;
  assert(/not valid JSON \((it ends too early, at line 1|line 1, column \d+)\)/.test(msg), msg);
  return 'check notes missing settings; outside folder link refused; lts/iron is an alias; fence refused; truncation located';
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

// --- session start: the offer, grounding, drift, guardrail health (design 4 and 6) ---------------------------
const SESSION = JSON.parse(read(join(PLUGIN, 'hooks', 'hooks.json'))).hooks.SessionStart[0].hooks[0].command;
const SETUP = join(PLUGIN, 'tools', 'setup.mjs');
// A session start through the real hooks.json command, as Claude Code runs it (Copilot with copilot: true).
function session(dir, { copilot = false, extra = {} } = {}) {
  const roots = copilot ? { COPILOT_PLUGIN_ROOT: PLUGIN, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN } : { CLAUDE_PLUGIN_ROOT: PLUGIN };
  const r = sh('/bin/sh', ['-c', SESSION], { cwd: dir, env: env({ ...roots, ...extra }) });
  assert(r.status === 0, `session start failed: exit ${r.status} ${r.stderr.trim().slice(0, 200)}`);
  return copilot ? JSON.parse(r.stdout || '{}').additionalContext || '' : r.stdout;
}
const setupCmd = (dir, ...a) => json(sh(NODE, [SETUP, ...a], { cwd: dir, env: env() }));
const COMBINED = /"Cartwright can study this project \(read-only\) and save a profile so I use its real commands and rules, and connect it to a client's project skills if it's for a client\. Reply set up, not now, or never here\."/;
const PROFILE_ONLY = /"Cartwright can study this project \(read-only\) and save a profile so I use its real commands and rules\. Reply set up, not now, or never here\."/;
const CLIENT_ONLY = /"Is this project for a client\? I can connect it to that client's project skills\. Reply set up, not now, or never here\."/;
const offered = (out) => /Reply set up, not now, or never here/.test(out);
const backdate = (dir, days) => {
  const f = join(STATE, 'projects.json'), j = readJson(f), key = Object.keys(j).find((k) => k === realpathSync(dir));
  j[key].at -= days * 864e5; writeFileSync(f, JSON.stringify(j));
};

step('the session\'s project comes from the agent, never from where the hook runs or the plugin\'s folder', () => {
  // The fixture the session is about (pnpm), and another repo with its own profile (uv) that holds a copy of the
  // plugin: an agent may start plugin hooks from the plugin's folder, as Copilot did, which used to ground the session
  // in the wrong project.
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const other = project('python').dir;
  ok(other, ['write', '--store', 'folder', ...LISTS]);
  const copy = join(other, 'plugin');
  cpSync(PLUGIN, copy, { recursive: true });
  const trace = join(WORK, `trace-${seq}`);
  const start = (extra, input = '') => {
    const r = sh('/bin/sh', ['-c', SESSION], { cwd: copy, input, env: env({ COPILOT_PLUGIN_ROOT: copy, PLUGIN_ROOT: copy, CLAUDE_PLUGIN_ROOT: copy, CARTWRIGHT_HOOK_TRACE: trace, ...extra }) });
    assert(r.status === 0, `session start failed: ${r.stderr.trim().slice(0, 200)}`);
    return JSON.parse(r.stdout || '{}').additionalContext || '';
  };
  const fromPayload = start({}, JSON.stringify({ cwd: dir, source: 'startup' }));
  assert(/Test: pnpm test/.test(fromPayload) && !/uv run pytest/.test(fromPayload), `payload cwd: ${fromPayload.slice(0, 300)}`);
  const fromVariable = start({ COPILOT_PROJECT_DIR: dir });
  assert(/Test: pnpm test/.test(fromVariable) && !/uv run pytest/.test(fromVariable), `COPILOT_PROJECT_DIR: ${fromVariable.slice(0, 300)}`);
  const fromNothing = start({});
  assert(!/Project profile/.test(fromNothing), `with nothing to go on, the plugin's folder grounded the session: ${fromNothing.slice(0, 200)}`);
  // The trace records the project chosen and exactly what the agent was given.
  const seen = read(trace).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
  assert(seen.length === 3 && seen[0].root === realpathSync(dir) && seen[0].context.includes('Test: pnpm test') && seen[2].root === null, `trace: ${JSON.stringify(seen).slice(0, 300)}`);
  return 'payload cwd and COPILOT_PROJECT_DIR ground the fixture from inside another repo\'s plugin folder; with neither, no project; the trace holds the context given';
});

step('this repo (G9): no setup offer, but its own profile grounds the session', () => {
  const out = session(ROOT);
  assert(!offered(out), 'the library repo was offered setup');
  assert(/\[cartwright\] Project profile \(\.cartwright\/profile\.json\)/.test(out), `no grounding in the library repo: ${out.slice(0, 200)}`);
  assert(/Guardrails: protected main, develop; generated plugin\/\*\* \(regenerate: npm run build\)/.test(out), 'the guardrails line is missing');
  return 'grounded from .cartwright/profile.json, guardrails listed, no offer';
});

step('first run (B12): an unset project gets the combined line first, with the three replies', () => {
  const { dir } = project('ts');
  const out = session(dir);
  assert(COMBINED.test(out) && out.indexOf('Reply set up') < out.indexOf('Not installed on this machine'), `no combined offer first: ${out.slice(0, 200)}`);
  assert(/REQUIRED: begin your very first reply/.test(out) && /follow the project-profile skill/.test(out) && /remember later/.test(out) && /remember never/.test(out), 'the replies are missing');
  assert(!/client-setup skill/.test(out) && (out.match(/Reply set up/g) || []).length === 1, 'a separate client question too');
  return 'combined line first; set up → project-profile, not now → remember later, never here → remember never';
});

step('not now (B13): nothing for 7 days, then the combined line again', () => {
  const { dir } = project('ts');
  setupCmd(dir, 'remember', 'later');
  assert(!offered(session(dir)), 'asked again straight away');
  backdate(dir, 6); assert(!offered(session(dir)), 'asked again within 7 days');
  backdate(dir, 2); assert(COMBINED.test(session(dir)), 'not asked again after 7 days');
  return 'quiet at day 0 and 6, asked at day 8';
});

step('never here (B14): never offered again, and nothing in the repo changes', () => {
  const { dir } = project('ts');
  const before = snapshot(dir);
  setupCmd(dir, 'remember', 'never');
  backdate(dir, 400);
  assert(!offered(session(dir)) && !offered(session(dir)), 'offered after never here');
  assert(snapshot(dir) === before && clean(dir), 'the repo changed');
  return 'no offer, even a year later; repo byte for byte unchanged';
});

step('the offer when the client is known: profile only (kit, no-client, done, clientProject: false)', () => {
  const kit = project('ts').dir;
  setupCmd(kit, 'kit', '--code', 'zzt', '--overlay', 'example/zzt-cartwright');
  const results = [['kit', session(kit)]];
  for (const choice of ['no-client', 'done']) { const { dir } = project('ts'); setupCmd(dir, 'remember', choice); results.push([choice, session(dir)]); }
  // no-client survives a later "not now", once its 7 days are over.
  const { dir: d } = project('ts'); setupCmd(d, 'remember', 'no-client'); setupCmd(d, 'remember', 'later'); backdate(d, 8);
  results.push(['no-client then later', session(d)]);
  const { dir: dd } = project('ts'); setupCmd(dd, 'remember', 'done'); setupCmd(dd, 'remember', 'later'); backdate(dd, 8);
  results.push(['done then later', session(dd)]);
  const bad = results.filter(([, out]) => !PROFILE_ONLY.test(out) || /client's project skills/.test(out)).map(([k]) => k);
  assert(!bad.length, `not the profile-only line: ${bad.join(', ')}`);
  const p = project('ts').dir; ok(p, ['write', '--store', 'folder', ...LISTS, '--client-project', 'no']);
  assert(!offered(session(p)), 'a profiled project with clientProject: false was still offered setup');
  // Recorded as a client project but no kit yet: offer to connect it, without asking again whether it's for a client.
  const c = project('ts').dir; ok(c, ['write', '--store', 'folder', ...LISTS, '--client-project', 'yes']);
  const connect = session(c);
  assert(/"This project is for a client but isn't connected to its project skills yet\. Reply set up, not now, or never here\."/.test(connect) && /follow the client-setup skill/.test(connect) && !CLIENT_ONLY.test(connect), `clientProject: true without a kit: ${connect.slice(0, 200)}`);
  return 'profile-only for kit, no-client, done and no-client-then-later; nothing when profiled and not for a client; the connect line when recorded as a client project without a kit';
});

step('a profiled project with no client recorded gets the client-only line; the library and overlay repos get none', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const out = session(dir);
  assert(CLIENT_ONLY.test(out) && /follow the client-setup skill/.test(out), `no client-only line: ${out.slice(0, 200)}`);
  const lib = project('unknown-stack', (d) => put(d, 'package.json', JSON.stringify({ name: 'cartwright' }) + '\n')).dir;
  ok(lib, ['write', '--store', 'folder', ...LISTS]);
  const l = session(lib);
  const overlay = project('unknown-stack', (d) => put(d, 'overlay.json', JSON.stringify({ project: 'zzt' }) + '\n')).dir;
  assert(!offered(l) && /\[cartwright\] Project profile/.test(l) && !offered(session(overlay)), 'library or overlay repo offered setup, or the library lost its grounding');
  return 'client-only line; library repo: no offer but grounded; overlay: no offer';
});

step('grounding (C23 input): the profile with sources in every storage mode, and the project\'s rules winning', () => {
  const labels = { folder: '.cartwright/profile.json', 'agents-md': 'the Cartwright section of AGENTS.md', machine: 'saved on this machine only' };
  for (const store of ['folder', 'agents-md', 'machine']) {
    const { dir } = project('python');
    ok(dir, ['write', '--store', store, '--protected', 'main', '--generated', 'src/gen/**=make gen']);
    const out = session(dir);
    assert(out.includes(`[cartwright] Project profile (${labels[store]})`), `${store}: no grounding: ${out.slice(0, 160)}`);
    assert(out.includes('If AGENTS.md, CLAUDE.md or .cursor/rules say otherwise, follow them') && out.includes(`A fact marked "not found" isn't known`), `${store}: the rules-win or not-found sentence is missing`);
    assert(out.includes('Test: uv run pytest (pyproject.toml#tool.pytest.ini_options)') && out.includes('Build: not found') && out.includes('Python 3.12.7 (.python-version)'), `${store}: facts or sources missing`);
    assert(out.includes('Guardrails: protected main; generated src/gen/** (regenerate: make gen)') && out.includes('profile.mjs" show --json'), `${store}: guardrails or the full-profile command missing`);
  }
  const sfra = project('sfra').dir; ok(sfra, ['write', '--store', 'folder', ...LISTS]);
  const g = session(sfra);
  assert(/Platform: Salesforce B2C Commerce, SFRA \(package\.json#paths\.base\)\. Prefer b2c-controllers, b2c-forms, b2c-isml; don't use sfnext-\* skills/.test(g), `SFRA guidance missing: ${g.split('\n').find((l) => l.includes('Platform'))}`);
  return 'folder, AGENTS.md and machine; sources, not found, rules win, guardrails; SFRA skill guidance';
});

step('drift at session start (A10): found in-process, mentioned until refreshed; the hook writes nothing', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  commitAll(dir, 'profile');
  const fresh = session(dir);
  assert(!/out of date/.test(fresh), 'drift reported on a fresh profile');
  editJson(join(dir, 'package.json'), (j) => { j.scripts.test = 'vitest run --coverage'; });
  const before = snapshot(dir);
  const trace = join(WORK, `trace-${process.pid}`);
  for (const n of [1, 2]) {
    const out = session(dir, { extra: { CARTWRIGHT_HOOK_TRACE: trace } });
    assert(/The project profile is out of date: commands\.test changed/.test(out) && /Mention this once in this session, and offer to refresh it/.test(out), `session ${n}: no drift note`);
    assert(/Test: pnpm test \(package\.json#scripts\.test\) \[out of date\]/.test(out), `session ${n}: the stale fact isn't marked`);
  }
  assert(snapshot(dir) === before, 'the session-start hook changed a file in the project');
  // Every node process the session start runs is recorded by a wrapper on the PATH: only the hook itself.
  const bin = join(WORK, `node-wrapper-${process.pid}`), calls = join(bin, 'calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'node'), `#!/bin/sh\necho "$@" >> "${calls}"\nexec "${NODE}" "$@"\n`, { mode: 0o755 });
  session(dir, { extra: { PATH: `${bin}:${BARE}` } });
  const ran = read(calls).trim().split('\n');
  assert(ran.length === 1 && /setup\.mjs hook$/.test(ran[0]), `node ran ${ran.length} times: ${ran.join(' | ')}`);
  ok(dir, ['refresh']);
  assert(!/out of date/.test(session(dir)), 'still reported after a refresh');
  return 'reported in two sessions, stale fact marked, project unchanged; gone after refresh';
});

step('guardrail health at session start: broken settings (G3) and a loosening personal file are said once', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  writeFileSync(join(dir, '.cartwright', 'settings.json'), '{ "cartwright": "settings",');
  const out = session(dir);
  assert(/can't be used: not valid JSON \(line 1, column \d+\)\. Built-in protections are on and the project's own rules are paused\./.test(out) && /Tell the person once/.test(out), `no broken-settings warning: ${out.slice(0, 300)}`);
  const p = project('ts').dir;
  ok(p, ['write', '--store', 'folder', ...LISTS]);
  put(p, '.cartwright/personal.json', JSON.stringify({ cartwright: 'personal', version: 1, guardrails: { secrets: false } }) + '\n');
  assert(/personal file tries to loosen team rules.*guardrails\.secrets/.test(session(p)), 'loosening not reported');
  return 'G3 message with the position; loosening named';
});

step('the plugin-root cache, and "guardrails are inactive" when the guard can\'t run here', () => {
  const { dir } = project('ts');
  const state = join(WORK, `state-cache-${process.pid}`);
  const out = session(dir, { extra: { CARTWRIGHT_STATE_DIR: state } });
  assert(read(join(state, 'plugin-root')).trim() === PLUGIN && !/Guardrails are inactive/.test(out), 'cache not written, or a false inactive note');
  const at = statSync(join(state, 'plugin-root')).mtimeMs;
  session(dir, { extra: { CARTWRIGHT_STATE_DIR: state } });
  assert(statSync(join(state, 'plugin-root')).mtimeMs === at, 'the cache was rewritten although nothing changed');
  // A plugin without the guard, and no cached root: inactive.
  const bare = join(WORK, `plugin-no-guard-${process.pid}`);
  cpSync(PLUGIN, bare, { recursive: true }); rmSync(join(bare, 'tools', 'guard.mjs'));
  const r = sh(NODE, [join(bare, 'tools', 'setup.mjs'), 'hook'], { cwd: dir, env: env({ CLAUDE_PLUGIN_ROOT: bare, CARTWRIGHT_STATE_DIR: join(WORK, `state-empty-${process.pid}`) }) });
  assert(/Guardrails are inactive in this agent: the guard can't be found/.test(r.stdout), `no inactive note: ${r.stdout.slice(0, 200)}`);
  // No node on the PATH the hooks use. This runs setup.mjs with an absolute node, as a control.
  // TODO(end-of-phase SessionStart edit, P6): once the entry has the node guard, also run the real SessionStart
  // command with a PATH holding only sh, and assert exit 0 (today it exits 127 there, before the helper can speak).
  const nonode = join(WORK, `no-node-${process.pid}`); mkdirSync(nonode, { recursive: true });
  symlinkSync(sh('/bin/sh', ['-c', 'command -v git']).stdout.trim(), join(nonode, 'git'));
  const n = sh(NODE, [SETUP, 'hook'], { cwd: dir, env: env({ CLAUDE_PLUGIN_ROOT: PLUGIN, PATH: nonode }) });
  assert(/Guardrails are inactive in this agent: node isn't on the PATH/.test(n.stdout), `no note without node: ${n.stdout.slice(0, 200)}`);
  return 'cache written once; inactive without the guard and without node';
});

step('overlay template (F49): starter settings protect main and develop and mark the build output; it validates, builds, and is never offered setup', () => {
  const d = join(WORK, `overlay-${process.pid}`);
  cpSync(join(ROOT, 'templates', 'overlay'), d, { recursive: true });
  editJson(join(d, 'overlay.json'), (o) => { Object.assign(o, { project: 'tst', client: 'Test Client', aliases: ['TC'], repo: 'example/tst-cartwright', owner: 'Test Lead', lead: '@test-lead' }); });
  git(d, 'init', '-q', '-b', 'main'); commitAll(d, 'from the template');
  const v = sh(NODE, [join(ROOT, 'scripts', 'validate.mjs'), '--overlay', d], { env: env() });
  const b = sh(NODE, [join(ROOT, 'scripts', 'build-overlay.mjs'), d], { env: env() });
  assert(v.status === 0 && b.status === 0, `validate: ${v.stderr.trim().slice(0, 200)} build: ${b.stderr.trim().slice(0, 200)}`);
  const s = ok(d, ['show']).settings;
  assert(s.status === 'ok' && s.effective.protectedBranches.join() === 'main,develop', `settings: ${JSON.stringify(s).slice(0, 200)}`);
  const gen = s.effective.generated.map((g) => g.path).join();
  assert(gen === 'plugin/**,INDEX.md,.claude-plugin/marketplace.json,.agents/plugins/marketplace.json,client-project/**', `generated: ${gen}`);
  assert(git(d, 'check-ignore', '.cartwright/personal.json').trim() === '.cartwright/personal.json', 'the personal file is not ignored');
  const out = session(d);
  assert(!offered(out), 'an overlay repo was offered setup');
  const g = (cmd) => JSON.parse(sh(NODE, [join(PLUGIN, 'tools', 'guard.mjs'), 'explain', cmd], { cwd: d, env: env() }).stdout);
  const push = g('git push origin main'), edit = g('echo x >> INDEX.md');
  assert(push.decision === 'deny' && edit.decision === 'deny' && /build-overlay\.mjs/.test(edit.message), `push: ${push.decision}; INDEX.md: ${edit.message}`);
  return 'settings valid; validate and build-overlay pass; no offer; push to main and an INDEX.md edit blocked';
});

step('Copilot gets the same session start as JSON additionalContext', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const ctx = session(dir, { copilot: true });
  assert(CLIENT_ONLY.test(ctx) && ctx.includes('[cartwright] Project profile (.cartwright/profile.json)'), `not in additionalContext: ${ctx.slice(0, 200)}`);
  return 'offer and grounding in additionalContext';
});

step('each agent gets the session start in the shape it reads: Claude Code text, Copilot and Codex JSON', () => {
  // Codex 0.162.1 drops plain text ("invalid session start JSON output"): it reads hookSpecificOutput.additionalContext.
  // Each agent is recognised by its variables (Codex: PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT, no Copilot variable).
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const run = (vars) => { const r = sh('/bin/sh', ['-c', SESSION], { cwd: dir, input: JSON.stringify({ cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }), env: env(vars) }); assert(r.status === 0, r.stderr); return r.stdout; };
  const claude = run({ CLAUDE_PLUGIN_ROOT: PLUGIN });
  assert(claude.startsWith('[cartwright]') && claude.includes('Test: pnpm test'), `Claude Code: ${claude.slice(0, 120)}`);
  const copilot = JSON.parse(run({ COPILOT_PLUGIN_ROOT: PLUGIN, PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN }));
  assert(Object.keys(copilot).join() === 'additionalContext' && copilot.additionalContext.includes('Test: pnpm test'), `Copilot: ${JSON.stringify(copilot).slice(0, 120)}`);
  const codex = JSON.parse(run({ PLUGIN_ROOT: PLUGIN, CLAUDE_PLUGIN_ROOT: PLUGIN }));
  assert(codex.hookSpecificOutput?.hookEventName === 'SessionStart' && codex.hookSpecificOutput.additionalContext.includes('Test: pnpm test') && Object.keys(codex).join() === 'hookSpecificOutput', `Codex: ${JSON.stringify(codex).slice(0, 120)}`);
  return 'Claude Code: plain text; Copilot: {additionalContext}; Codex: {hookSpecificOutput: {hookEventName: SessionStart, additionalContext}}';
});

step('status.profile (C27): where the profile is, the host, PR template, client and default branch', () => {
  const { dir } = project('ts');
  assert(setupCmd(dir, 'status').profile === null, 'an unprofiled project has a profile in status');
  ok(dir, ['write', '--store', 'folder', ...LISTS, '--client-project', 'no']);
  const p = setupCmd(dir, 'status').profile;
  assert(p.store === 'folder' && p.settings === 'ok' && p.remoteHost === 'local' && p.prTemplate === '.github/pull_request_template.md' && p.clientProject === false && p.defaultBranch === 'main', JSON.stringify(p));
  return JSON.stringify(p);
});

step('session start time (E45): what the hook adds to starting node, with no network', () => {
  const { dir } = project('ts');
  ok(dir, ['write', '--store', 'folder', ...LISTS]);
  const nowhere = { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  // Sampled in turn with a bare node start through sh, so background load affects both alike. The absolute numbers
  // are reported for the tester, who measures E45 (about a quarter of a second) on a quiet machine.
  const ms = (f) => { const t = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const q = (xs, x) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(x * xs.length))];
  // Judged on the median of 20 paired differences (hook_i - node_i, sampled in turn), so one stall can't fail it.
  const bare = [], hook = [];
  for (let i = 0; i < 20; i++) {
    bare.push(ms(() => sh('/bin/sh', ['-c', `exec "${NODE}" -e 0`], { cwd: dir, env: env() })));
    hook.push(ms(() => assert(/\[cartwright\] Project profile/.test(session(dir, { extra: nowhere })), 'no grounding')));
  }
  const adds = q(hook.map((x, i) => x - bare[i]), 0.5);
  const line = `session start p50 ${q(hook, 0.5).toFixed(0)} ms, p95 ${q(hook, 0.95).toFixed(0)} ms; node alone p50 ${q(bare, 0.5).toFixed(0)} ms, p95 ${q(bare, 0.95).toFixed(0)} ms; the hook adds ${adds.toFixed(0)} ms (median of 20 paired differences; budget 100)`;
  assert(adds <= 200, `the session start adds more than twice its budget: ${line}`);
  return line;
}, { alone: true, timing: true });

process.exit(await report('Cartwright profile test', { keep: KEEP }));
