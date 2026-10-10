#!/usr/bin/env node
// The project profiler. Studies a project of any stack, read-only, and records what it finds (stack, Node or
// Python pin, package manager, build/test/lint commands, layout, conventions, protected-branch candidates), each
// fact with the file it came from, or "not found". It reads a fixed allowlist of files, never opens credential
// files, hides any value that looks like a secret, and writes the same bytes for the same project. Shipped in the
// plugin as tools/profile.mjs. No dependencies: Node and git only.
//
//   node profile.mjs study                    JSON: the proposed profile and settings; changes nothing
//   node profile.mjs write --store folder|agents-md|machine [--protected main,develop] [--generated '<glob>=<cmd>' …]
//                          [--allow <loc>] [--protect <loc>] [--client-project yes|no]
//                                             save the profile and settings, after the person said yes. A list
//                                             option replaces that list (none empties it); without it, the saved
//                                             settings keep theirs, or a new file gets what study proposed
//   node profile.mjs diff                     JSON: the facts that differ from the saved profile, before and after
//   node profile.mjs refresh                  save only those facts into the saved profile, after a yes
//   node profile.mjs show [--json]            JSON: the saved profile, where it's stored, the settings that apply
//   node profile.mjs check                    JSON: quick drift and settings check (exit 1 if out of date or broken)
// Options: --dir <path> runs against another project folder. Exit 2 on usage errors.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import STACKS from './stacks/index.mjs';
import { parseToml } from './stacks/python.mjs';
import { HIDDEN, isSecretPath, secretKind } from './secret-rules.mjs';
import { buildSettings, DEFAULT_PROTECTED, resolveSettings, validateSettings } from './settings.mjs';
import { found, load, MODES, save } from './store.mjs';

export const PROFILE_VERSION = 1;
// The only files the profiler opens. Everything else is checked for existence or listed, never read.
const READABLE = new Set(['package.json', 'tsconfig.json', '.nvmrc', '.node-version', '.tool-versions', '.python-version', 'pyproject.toml', 'Makefile']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', '__pycache__']);
const LIST_MAX = 2000;
const MAX_BYTES = 512 * 1024;
// Branch names that are usually protected; the remote's default branch is always a candidate too.
const BRANCH_CANDIDATES = ['main', 'master', 'develop', 'development', 'trunk'];
const SOURCE_DIRS = ['src', 'lib', 'app', 'apps', 'packages'];
const TEST_DIRS = ['test', 'tests', '__tests__', 'e2e', 'spec'];
const RULES_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules', '.cursorrules', '.github/copilot-instructions.md'];
const ADR_DIRS = ['docs/adr', 'docs/adrs', 'docs/decisions', 'docs/architecture/decisions', 'doc/adr', 'documentation/decisions', 'adr', 'adrs', 'decisions'];
const PR_TEMPLATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', '.github/PULL_REQUEST_TEMPLATE', 'docs/pull_request_template.md', 'pull_request_template.md', '.gitlab/merge_request_templates'];
const TRACKERS = [['.github/ISSUE_TEMPLATE', 'github-issues'], ['.gitlab/issue_templates', 'gitlab-issues']];
const GENERATED_HEADER = ['@generated', 'DO NOT EDIT', 'Do not edit by hand', 'AUTO-GENERATED'];
const HEADER_LINES = 5;
const BUILD_OUTPUT = ['dist', 'build', 'out'];
const NOT_FOUND = { status: 'not found' };

// --- reading the project: read-only, bounded, and refusing credential files --------------------------------------
export function makeCtx(root) {
  const inside = (rel) => { const n = normalize(rel); if (isAbsolute(n) || n.split(/[\\/]/).includes('..')) throw new Error(`outside the project: ${rel}`); return join(root, n); };
  const isDir = (rel) => { try { return statSync(inside(rel)).isDirectory(); } catch { return false; } };
  const ctx = {
    exists: (rel) => existsSync(inside(rel)),
    isDir,
    // Entries under a folder, repo-relative, folders ending in "/", sorted; bounded in depth and count.
    list(rel = '.', { depth = 1, max = LIST_MAX } = {}) {
      const out = [];
      const walk = (d, level) => {
        let names; try { names = readdirSync(inside(d)).sort(); } catch { return; }
        for (const n of names) {
          if (out.length >= max || SKIP_DIRS.has(n)) continue;
          const r = d === '.' ? n : `${d}/${n}`;
          const dir = isDir(r);
          out.push(dir ? `${r}/` : r);
          if (dir && level < depth) walk(r, level + 1);
        }
      };
      walk(rel.replace(/\/$/, ''), 1);
      return out;
    },
    // A file's text, only for the allowlisted files, never for credential files.
    text(rel) {
      const name = rel.split('/').pop();
      if (!READABLE.has(name) || isSecretPath(rel)) return null;
      try { const p = inside(rel); return statSync(p).size > MAX_BYTES ? null : readFileSync(p, 'utf8'); } catch { return null; }
    },
    json(rel) { try { const t = ctx.text(rel); return t === null ? null : JSON.parse(t); } catch { return null; } },
    toml(rel) { try { const t = ctx.text(rel); return t === null ? null : parseToml(t); } catch { return null; } },
    // git, without taking any lock or writing anything under .git. stdout, or null on failure.
    git(...args) {
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
      return r.status === 0 ? r.stdout : null;
    },
    facts: {},
  };
  return ctx;
}

// --- facts every project has, whatever its stack ----------------------------------------------------------------
function remoteHost(ctx) {
  const url = (ctx.git('remote', 'get-url', 'origin') || '').trim();
  if (!url) return NOT_FOUND;
  // Only the kind of host is kept, never the URL: no organisation or client names in the profile.
  const kind = /github\.com[/:]/i.test(url) ? 'github' : /gitlab/i.test(url) ? 'gitlab' : /bitbucket\.org[/:]/i.test(url) ? 'bitbucket'
    : /dev\.azure\.com|visualstudio\.com/i.test(url) ? 'azure-devops' : /^(\/|\.|file:|[A-Za-z]:\\)/.test(url) ? 'local' : 'other';
  return { status: 'found', value: kind, source: 'git: remote origin' };
}

function branchCandidates(ctx) {
  // One git call: every local and origin ref, with origin/HEAD's target (the remote's default branch).
  const lines = (ctx.git('for-each-ref', '--format=%(refname) %(symref)', 'refs/heads', 'refs/remotes/origin') || '').split('\n').filter(Boolean);
  const refs = lines.map((l) => l.split(' ')[0]);
  const found = new Map();
  const head = (lines.find((l) => l.startsWith('refs/remotes/origin/HEAD ')) || '').split(' ')[1] || '';
  if (head.startsWith('refs/remotes/origin/')) found.set(head.slice('refs/remotes/origin/'.length), 'refs/remotes/origin/HEAD');
  for (const name of BRANCH_CANDIDATES) {
    if (found.has(name)) continue;
    const ref = [`refs/remotes/origin/${name}`, `refs/heads/${name}`].find((r) => refs.includes(r));
    if (ref) found.set(name, ref);
  }
  if (!found.size) return NOT_FOUND;
  return { status: 'found', value: [...found.keys()].sort(), source: `git: ${[...new Set(found.values())].sort().join(', ')}` };
}

function conventions(ctx) {
  const first = (paths) => paths.find((p) => ctx.exists(p));
  const at = (p) => (p ? { status: 'found', path: p } : NOT_FOUND);
  const rules = RULES_FILES.filter((p) => ctx.exists(p));
  const tracker = TRACKERS.find(([p]) => ctx.exists(p));
  return {
    rulesFiles: rules.length ? { status: 'found', value: rules.map((path) => ({ path })) } : NOT_FOUND,
    specKit: at(ctx.isDir('.specify') ? '.specify' : null),
    adrs: at(ADR_DIRS.find((p) => ctx.isDir(p))),
    prTemplate: at(first(PR_TEMPLATES)),
    tracker: tracker ? { status: 'found', value: tracker[1], source: tracker[0] } : NOT_FOUND,
  };
}

// Generated-file candidates beyond the stack modules': tracked files with a "generated, do not edit" header
// (file names only, credential files and lockfiles excluded) and tracked build output.
function generatedCandidates(ctx, build) {
  const out = [];
  const exclude = ['.env*', 'dw.json', '*.pem', '*.key', 'id_rsa*', '*.p12', '*.pfx', '.npmrc', '.netrc', 'credentials*',
    'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock']
    .map((p) => `:(exclude,glob)**/${p}`);
  // -z output: path NUL line NUL text. Only the path and line number are used, and only matches near the top count.
  const grep = ctx.git('grep', '-n', '-z', '-I', '-F', ...GENERATED_HEADER.flatMap((h) => ['-e', h]), '--', '.', ...exclude);
  const headers = new Set();
  for (const line of (grep || '').split('\n')) { const [path, n] = line.split('\0'); if (path && Number(n) <= HEADER_LINES) headers.add(path); }
  for (const path of [...headers].sort().slice(0, 50)) out.push({ path, source: 'git grep: a "generated, do not edit" header' });
  const tracked = (ctx.git('ls-files', '--', ...BUILD_OUTPUT) || '').split('\n').filter(Boolean);
  for (const d of BUILD_OUTPUT) {
    if (tracked.some((f) => f.startsWith(`${d}/`))) out.push({ path: `${d}/**`, ...(build ? { regenerate: build.run } : {}), source: `git: tracked files in ${d}/` });
  }
  return out;
}

// Replace anything that looks like a secret, anywhere in the result.
function hideSecrets(v) {
  if (typeof v === 'string') return secretKind(v) ? HIDDEN : v;
  if (Array.isArray(v)) return v.map(hideSecrets);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideSecrets(x)]));
  return v;
}

// --- detection --------------------------------------------------------------------------------------------------
// The profile of a project. With { suggestions: false } (the quick drift check) the generated-file search is
// skipped, which keeps it cheap; suggestions are never part of drift.
export function detect(root, { suggestions = true } = {}) {
  const ctx = makeCtx(root);
  const f = ctx.facts;
  const acc = { languages: [], frameworks: [], commands: {}, layout: {}, generated: [], prefer: [], avoid: [] };
  for (const mod of STACKS) {
    const r = mod.detect(ctx);
    if (!r) continue;
    for (const k of ['platform', 'node', 'python', 'packageManager', 'otherScripts']) if (r[k] && !f[k]) f[k] = r[k];
    for (const l of r.languages || []) if (!acc.languages.some((x) => x.value === l.value)) acc.languages.push(l);
    for (const x of r.frameworks || []) if (!acc.frameworks.some((y) => y.name === x.name)) acc.frameworks.push(x);
    for (const [k, c] of Object.entries(r.commands || {})) acc.commands[k] ||= c;
    for (const [k, l] of Object.entries(r.layout || {})) acc.layout[k] ||= l;
    for (const g of r.generated || []) if (!acc.generated.some((y) => y.path === g.path)) acc.generated.push(g);
    acc.prefer.push(...(r.guidance?.preferSkills || []));
    acc.avoid.push(...(r.guidance?.avoidSkills || []));
    f.commands = acc.commands;
  }
  const dirs = (names) => names.filter((n) => ctx.isDir(n));
  if (dirs(SOURCE_DIRS).length) acc.layout.sourceDirs ||= { value: dirs(SOURCE_DIRS), source: dirs(SOURCE_DIRS).map((d) => `${d}/`).join(', ') };
  if (dirs(TEST_DIRS).length) acc.layout.testDirs ||= { value: dirs(TEST_DIRS), source: dirs(TEST_DIRS).map((d) => `${d}/`).join(', ') };

  const scalar = (x) => (x ? { status: 'found', ...x } : NOT_FOUND);
  const layoutKeys = Object.keys(acc.layout).sort();
  const facts = {
    platform: scalar(f.platform),
    languages: acc.languages.length ? { status: 'found', value: acc.languages } : NOT_FOUND,
    node: scalar(f.node),
    python: scalar(f.python),
    packageManager: scalar(f.packageManager),
    commands: Object.fromEntries(['build', 'test', 'lint'].map((k) => [k, scalar(acc.commands[k])])),
    otherScripts: scalar(f.otherScripts),
    frameworks: acc.frameworks.length ? { status: 'found', value: [...acc.frameworks].sort((a, b) => a.name.localeCompare(b.name)) } : NOT_FOUND,
    layout: layoutKeys.length ? { status: 'found', value: Object.fromEntries(layoutKeys.map((k) => [k, acc.layout[k].value])), source: [...new Set(layoutKeys.map((k) => acc.layout[k].source))].join(', ') } : NOT_FOUND,
    remoteHost: remoteHost(ctx),
    protectedBranchCandidates: branchCandidates(ctx),
  };
  const profile = {
    cartwright: 'profile', version: PROFILE_VERSION, facts, conventions: conventions(ctx),
    guidance: { preferSkills: [...new Set(acc.prefer)].sort(), avoidSkills: [...new Set(acc.avoid)].sort() },
  };
  if (suggestions) {
    const gen = [...acc.generated];
    for (const g of generatedCandidates(ctx, acc.commands.build)) if (!gen.some((y) => y.path === g.path)) gen.push(g);
    profile.suggestions = { generated: gen.sort((a, b) => a.path.localeCompare(b.path)) };
  }
  return hideSecrets(profile);
}

// --- comparing a saved profile with a fresh one -----------------------------------------------------------------
// Keys compared, as paths: each fact (each command on its own), each convention, the skill guidance and, unless
// quick, the suggestions.
function keysOf(a, b, quick) {
  const keys = new Set();
  for (const p of [a, b]) {
    for (const k of Object.keys(p?.facts || {})) if (k !== 'commands') keys.add(`facts.${k}`);
    for (const k of Object.keys(p?.facts?.commands || {})) keys.add(`facts.commands.${k}`);
    for (const k of Object.keys(p?.conventions || {})) keys.add(`conventions.${k}`);
  }
  keys.add('guidance');
  if (!quick) keys.add('suggestions');
  return [...keys].sort();
}
const getPath = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) {
  const ks = path.split('.');
  let x = o;
  for (const k of ks.slice(0, -1)) x = x[k] && typeof x[k] === 'object' ? x[k] : (x[k] = {});
  if (v === undefined) delete x[ks.at(-1)]; else x[ks.at(-1)] = v;
}
const same = (a, b) => JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
const sortDeep = (v) => (Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])])) : v);

export function compare(saved, fresh, { quick = false } = {}) {
  return keysOf(saved, fresh, quick).filter((k) => !same(getPath(saved, k), getPath(fresh, k)))
    .map((key) => ({ key, before: getPath(saved, key) ?? null, after: getPath(fresh, key) ?? null }));
}

// --- a few plain lines about the profile, for people (the AGENTS.md section) -----------------------------------
const fmt = (x, f) => (x?.status === 'found' ? f(x) : 'not found');
export function summaryLines(p) {
  const f = p.facts || {}, c = f.commands || {}, cv = p.conventions || {};
  const cmd = (k) => fmt(c[k], (x) => `${x.run} (${x.source})`);
  return [
    `- Platform: ${fmt(f.platform, (x) => `${x.value}, ${x.flavour} (${x.source})`)}`,
    `- Languages: ${fmt(f.languages, (x) => x.value.map((l) => l.value).join(', '))} · Node: ${fmt(f.node, (x) => `${x.value} (${x.source})`)} · Python: ${fmt(f.python, (x) => `${x.value} (${x.source})`)}`,
    `- Package manager: ${fmt(f.packageManager, (x) => `${x.value} (${x.source})`)}`,
    `- Build: ${cmd('build')} · Test: ${cmd('test')} · Lint: ${cmd('lint')}`,
    `- Layout: ${fmt(f.layout, (x) => Object.entries(x.value).map(([k, v]) => `${k} ${[].concat(v).join(', ')}`).join('; '))}`,
    `- Rules files: ${fmt(cv.rulesFiles, (x) => x.value.map((r) => r.path).join(', '))} · PR template: ${fmt(cv.prTemplate, (x) => x.path)}`,
    '- A fact marked "not found" isn\'t known: say so, don\'t guess.',
  ];
}

// --- the proposal, and the profile's own checks -----------------------------------------------------------------
export function validateProfile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['the file must hold a JSON object'];
  if (typeof data.version === 'number' && data.version > PROFILE_VERSION) return [`version ${data.version}: this profile needs a newer Cartwright; update the plugin`];
  const errors = [];
  if (data.cartwright !== 'profile') errors.push('cartwright: must be "profile"');
  if (data.version !== PROFILE_VERSION) errors.push(`version: must be ${PROFILE_VERSION}`);
  if (!data.facts || typeof data.facts !== 'object') errors.push('facts: missing');
  return errors;
}

// The settings study proposes for a project that has none: the detected branches (or main and develop), and the
// generated-file suggestions that come with a regenerate command.
export function proposedLists(profile) {
  const c = profile.facts.protectedBranchCandidates;
  return {
    protectedBranches: c.status === 'found' ? c.value : [...DEFAULT_PROTECTED],
    generated: (profile.suggestions?.generated || []).filter((g) => g.regenerate).map(({ path, regenerate }) => ({ path, regenerate })),
  };
}

// --- the command line -------------------------------------------------------------------------------------------
function cli(argv) {
  const [cmd, ...rest] = argv;
  const opt = (flag) => { const i = rest.indexOf(flag); return i > -1 ? rest[i + 1] : undefined; };
  const many = (flag) => rest.flatMap((a, i) => (a === flag && rest[i + 1] !== undefined ? [rest[i + 1]] : []));
  const out = (o) => console.log(JSON.stringify(o, null, 2));
  const usage = (msg) => { console.error(`profile: ${msg}`); process.exit(2); };
  const stop = (msg) => { console.error(`profile: ${msg}`); process.exit(1); };
  if (!['study', 'write', 'diff', 'refresh', 'show', 'check'].includes(cmd)) usage('usage: profile.mjs study | write --store folder|agents-md|machine […] | diff | refresh | show [--json] | check   (see the top of this file)');

  const dir = opt('--dir') || process.cwd();
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (top.status !== 0) usage('Not a git repository: open the project\'s folder (the one with .git) and run it again.');
  const root = realpathSync(top.stdout.trim());
  const stored = load(root);
  const savedProfile = () => {
    if (stored.profile.status === 'none') stop('No saved profile here. Run "profile.mjs study", show the proposal to the person, then "profile.mjs write --store …" after their yes.');
    const errors = stored.profile.status === 'ok' ? validateProfile(stored.profile.data) : stored.profile.errors;
    if (errors.length) stop(`The saved profile (${stored.profile.file}) can't be used: ${errors.join('; ')}.`);
    return stored.profile.data;
  };

  if (cmd === 'study') {
    const profile = detect(root);
    const team = stored.settings.status === 'ok' && validateSettings(stored.settings.data).ok ? stored.settings.data : null;
    out({ profile, proposedSettings: buildSettings(team, team ? {} : proposedLists(profile)), stored: { store: stored.mode, found: stored.found } });
    return;
  }

  if (cmd === 'write') {
    const store = opt('--store');
    if (!store) usage('Choose where to store it: --store folder (default), agents-md or machine.');
    if (!MODES.includes(store)) usage(`--store must be folder, agents-md or machine (got "${store}")`);
    const list = (v) => (v === undefined ? undefined : v === 'none' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean));
    const generated = many('--generated');
    for (const g of generated) if (g !== 'none' && !/^[^=]+=.+$/.test(g)) usage(`--generated takes '<glob>=<regenerate command>', got "${g}"`);
    const cp = opt('--client-project');
    if (cp !== undefined && !['yes', 'no'].includes(cp)) usage('--client-project takes yes or no');
    const target = load(root, store);
    if (target.settings.status === 'broken') stop(`The existing settings (${target.settings.file}) can't be read: ${target.settings.errors.join('; ')}. Fix or move that file by hand, then run write again.`);
    let base = null;
    for (const s of [target.settings, stored.settings]) {
      if (s.status !== 'ok') continue;
      const v = validateSettings(s.data);
      if (!v.ok && s === target.settings) stop(`The existing settings (${s.file}) can't be used: ${v.errors.join('; ')}. Fix them by hand, then run write again.`);
      if (v.ok) { base = s.data; break; }
    }
    const profile = detect(root);
    const proposal = base ? {} : proposedLists(profile);
    const settings = buildSettings(base, {
      protectedBranches: list(opt('--protected')) || proposal.protectedBranches,
      generated: generated.length ? generated.filter((g) => g !== 'none').map((g) => { const i = g.indexOf('='); return { path: g.slice(0, i).trim(), regenerate: g.slice(i + 1).trim() }; }) : proposal.generated,
      allowed: many('--allow').length ? many('--allow') : undefined,
      protect: many('--protect').length ? many('--protect') : undefined,
      clientProject: cp === undefined ? undefined : cp === 'yes',
    });
    const v = validateSettings(settings);
    if (!v.ok) usage(`those settings aren't valid: ${v.errors.join('; ')}`);
    let changed;
    try {
      changed = save(root, store, { profile, settings, summary: summaryLines(profile) });
      // Creating AGENTS.md changes the profile itself (it's a rules file now): detect again so it isn't stale at once.
      const again = store === 'agents-md' ? detect(root) : profile;
      if (compare(profile, again).length) changed = [...new Set([...changed, ...save(root, store, { profile: again, settings, summary: summaryLines(again) })])];
    } catch (e) { stop(e.message); }
    out({ store, changed, otherStores: found(root).filter((m) => m !== store) });
    return;
  }

  if (cmd === 'diff' || cmd === 'refresh') {
    const saved = savedProfile();
    const changes = compare(saved, detect(root));
    if (cmd === 'diff') { out({ store: stored.mode, upToDate: !changes.length, changed: changes }); return; }
    const updated = JSON.parse(JSON.stringify(saved));
    for (const c of changes) setPath(updated, c.key, c.after ?? undefined);
    let changed = [];
    try { if (changes.length) changed = save(root, stored.mode, { profile: updated, summary: summaryLines(updated) }); } catch (e) { stop(e.message); }
    out({ store: stored.mode, changed, facts: changes.map((c) => c.key) });
    return;
  }

  const profile = stored.profile.status === 'ok' && !validateProfile(stored.profile.data).length ? stored.profile.data : null;
  const r = resolveSettings({ team: stored.settings, personal: stored.personal, profile });
  const settings = { status: r.status, file: stored.settings.file, message: r.message, loosening: r.loosening, warnings: r.warnings, effective: r.settings };
  if (cmd === 'show') {
    out({ store: stored.mode, found: stored.found, profile, profileStatus: stored.profile.status === 'ok' && !profile ? 'broken' : stored.profile.status, settings });
    return;
  }
  // check: the cheap version the session start uses (no generated-file search).
  if (!stored.mode) { out({ profiled: false, settings: 'none' }); return; }
  const changes = profile ? compare(profile, detect(root, { suggestions: false }), { quick: true }) : [];
  out({ profiled: !!profile, store: stored.mode, found: stored.found, upToDate: !!profile && !changes.length, changed: changes.map((c) => c.key), settings: r.status, message: r.message });
  process.exit((profile && changes.length) || r.status === 'broken' || (stored.profile.status !== 'none' && !profile) ? 1 : 0);
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) cli(process.argv.slice(2));
