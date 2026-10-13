#!/usr/bin/env node
// The project profiler. Studies a project of any stack, read-only, and records what it finds (stack, Node or
// Python pin, package manager, build/test/lint commands, layout, conventions, protected-branch candidates), each
// fact with the file it came from, or "not found". It reads a fixed allowlist of files, never opens credential
// files, hides any value that looks like a secret, and writes the same bytes for the same project. Shipped in the
// plugin as tools/profile.mjs. No dependencies: Node and git only.
//
//   node profile.mjs study                    JSON: the proposed profile and settings; changes nothing
//   node profile.mjs write --store folder|agents-md|machine --protected main,develop --generated '<glob>=<cmd>' …
//                          [--secrets-allow <glob> …] [--allow-location <loc> …] [--protect-location <loc> …]
//                          [--client-project yes|no]
//                                             save the profile and settings, after the person said yes. A list
//                                             option replaces that list; none empties it. New settings need
//                                             --protected and --generated (study prints the command to confirm);
//                                             existing settings keep any list that isn't given
//   node profile.mjs diff                     JSON: the facts that differ from the saved profile, before and after
//   node profile.mjs refresh                  save only those facts into the saved profile, after a yes
//   node profile.mjs show [--json]            JSON: the saved profile, where it's stored, the settings that apply
//   node profile.mjs check                    JSON: quick drift and settings check (exit 1 if out of date or broken)
// Options: --dir <path> runs against another project folder. Exit 2 on usage errors.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import STACKS from './stacks/index.mjs';
import { parseToml } from './stacks/python.mjs';
import { HIDDEN, isSecretPath, SECRET_FILE_GLOBS, secretKind } from './secret-rules.mjs';
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
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock'];
// Order by code point, never by locale, so every machine sorts the same way.
export const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- reading the project: read-only, bounded, and refusing credential files --------------------------------------
// Raised when detection runs past its deadline (the session-start drift check is time-boxed); the caller skips.
export class DetectDeadline extends Error { constructor() { super('detection ran out of time'); this.deadline = true; } }

export function makeCtx(root, deadline = Infinity) {
  const inside = (rel) => { const n = normalize(rel); if (isAbsolute(n) || n.split(/[\\/]/).includes('..')) throw new Error(`outside the project: ${rel}`); return join(root, n); };
  // Whether a path, after following symlinks, is still inside the project.
  const real = realpathSync(root);
  const within = (p) => { try { const r = realpathSync(p); return r === real || r.startsWith(real + sep); } catch { return false; } };
  // A name counts only with its exact case, taken from the parent folder's listing: on a case-insensitive disk
  // (macOS) claude.md must not pass for CLAUDE.md, or the same project would profile differently on Linux.
  const listings = new Map();
  const namesIn = (abs) => { if (!listings.has(abs)) { let n = null; try { n = new Set(readdirSync(abs)); } catch { /* unreadable */ } listings.set(abs, n); } return listings.get(abs); };
  const exact = (rel) => { let d = root; for (const p of normalize(rel).split(/[\\/]/).filter((x) => x && x !== '.')) { if (!namesIn(d)?.has(p)) return false; d = join(d, p); } return true; };
  const isDir = (rel) => { try { return exact(rel) && statSync(inside(rel)).isDirectory(); } catch { return false; } };
  const ctx = {
    exists: (rel) => exact(rel) && existsSync(inside(rel)),
    isDir,
    // Entries under a folder, repo-relative, folders ending in "/", sorted; bounded in depth and count. A folder that
    // leads outside the project lists nothing, and symlinked folders are listed as entries but never entered.
    list(rel = '.', { depth = 1, max = LIST_MAX } = {}) {
      const out = [];
      const start = rel.replace(/\/$/, '') || '.';
      if (!within(inside(start))) return out;
      const walk = (d, level) => {
        let entries; try { entries = readdirSync(inside(d), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); } catch { return; }
        for (const e of entries) {
          if (out.length >= max || SKIP_DIRS.has(e.name)) continue;
          const r = d === '.' ? e.name : `${d}/${e.name}`;
          out.push(e.isDirectory() ? `${r}/` : r);
          if (e.isDirectory() && level < depth) walk(r, level + 1);
        }
      };
      walk(start, 1);
      return out;
    },
    // A file's text, only for the allowlisted files inside the project (symlinks followed only if they stay
    // inside), never for credential files.
    text(rel) {
      const name = rel.split('/').pop();
      if (!READABLE.has(name) || isSecretPath(rel)) return null;
      // The real target's name counts too: .nvmrc → .env must never open .env.
      try { const p = inside(rel); return !exact(rel) || !within(p) || isSecretPath(realpathSync(p)) || statSync(p).size > MAX_BYTES ? null : readFileSync(p, 'utf8'); } catch { return null; }
    },
    json(rel) { try { const t = ctx.text(rel); return t === null ? null : JSON.parse(t); } catch { return null; } },
    toml(rel) { try { const t = ctx.text(rel); return t === null ? null : parseToml(t); } catch { return null; } },
    // refs/heads and refs/remotes/origin as "<ref> <symref target>" lines, from .git's loose refs and packed-refs;
    // null when .git isn't a folder (a worktree or submodule).
    gitRefs() {
      const git = join(root, '.git');
      try { if (!lstatSync(git).isDirectory()) return null; } catch { return null; }
      const refs = new Map();
      try {
        for (const line of readFileSync(join(git, 'packed-refs'), 'utf8').split('\n')) {
          const m = line.match(/^[0-9a-f]{40,64} (refs\/(heads|remotes\/origin)\/.+)$/);
          if (m) refs.set(m[1], '');
        }
      } catch { /* no packed refs */ }
      const walk = (rel) => {
        let entries; try { entries = readdirSync(join(git, rel), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const r = `${rel}/${e.name}`;
          if (e.isDirectory()) { walk(r); continue; }
          let text = ''; try { text = readFileSync(join(git, r), 'utf8').trim(); } catch { continue; }
          refs.set(r, text.startsWith('ref: ') ? text.slice(5) : '');
        }
      };
      walk('refs/heads');
      walk('refs/remotes/origin');
      return [...refs].sort(([a], [b]) => byCodePoint(a, b)).map(([r, sym]) => `${r} ${sym}`);
    },
    // The repository's own config file, when .git is a folder; null otherwise (a worktree or submodule).
    gitConfig() { try { return lstatSync(join(root, '.git')).isDirectory() ? readFileSync(join(root, '.git', 'config'), 'utf8') : null; } catch { return null; } },
    // git, without taking any lock or writing anything under .git. stdout, or null on failure.
    git(...args) {
      const left = deadline - Date.now();
      if (left <= 0) throw new DetectDeadline();
      const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: Math.min(8000, left), env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
      if (r.error?.code === 'ETIMEDOUT' && left < 8000) throw new DetectDeadline();
      return r.status === 0 ? r.stdout : null;
    },
    facts: {},
  };
  return ctx;
}

// --- facts every project has, whatever its stack ----------------------------------------------------------------
// origin's URL: read from .git/config when .git is a folder (no git process, which keeps the session-start drift
// check fast), else from git. Only the kind of host is kept.
function originUrl(ctx) {
  const config = ctx.gitConfig();
  if (config === null) return (ctx.git('remote', 'get-url', 'origin') || '').trim();
  let origin = false;
  for (const line of config.split(/\r?\n/)) {
    const h = line.match(/^\s*\[(.+)\]\s*$/);
    if (h) { origin = /^remote\s+"origin"$/.test(h[1].trim()); continue; }
    const m = origin && line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return '';
}

function remoteHost(ctx) {
  const url = originUrl(ctx);
  if (!url) return NOT_FOUND;
  // Only the kind of host is kept, never the URL: no organisation or client names in the profile.
  const kind = /github\.com[/:]/i.test(url) ? 'github' : /gitlab/i.test(url) ? 'gitlab' : /bitbucket\.org[/:]/i.test(url) ? 'bitbucket'
    : /dev\.azure\.com|visualstudio\.com/i.test(url) ? 'azure-devops' : /^(\/|\.|file:|[A-Za-z]:\\)/.test(url) ? 'local' : 'other';
  return { status: 'found', value: kind, source: 'git: remote origin' };
}

function branchCandidates(ctx) {
  // Every local and origin ref, with origin/HEAD's target (the remote's default branch): read from .git's files when
  // it's a folder (no git process, for the session-start drift check), else from one git call.
  const lines = ctx.gitRefs() ?? (ctx.git('for-each-ref', '--format=%(refname) %(symref)', 'refs/heads', 'refs/remotes/origin') || '').split('\n').filter(Boolean);
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
  const exclude = [...SECRET_FILE_GLOBS, ...LOCKFILES].map((p) => `:(exclude,glob)**/${p}`);
  // -z output: path NUL line NUL text. Only the path and line number are used, and only matches near the top count.
  const grep = ctx.git('grep', '-n', '-z', '-I', '-F', ...GENERATED_HEADER.flatMap((h) => ['-e', h]), '--', '.', ...exclude);
  const headers = new Set();
  for (const line of (grep || '').split('\n')) { const [path, n] = line.split('\0'); if (path && Number(n) <= HEADER_LINES) headers.add(path); }
  for (const path of [...headers].sort().slice(0, 50)) out.push({ path, source: 'git grep: a "generated, do not edit" header' });
  const tracked = (ctx.git('ls-files', '--', ...BUILD_OUTPUT) || '').split('\n').filter(Boolean);
  for (const d of BUILD_OUTPUT) {
    if (tracked.some((f) => f.startsWith(`${d}/`))) out.push({ path: `${d}/**`, ...(build?.run ? { regenerate: build.run } : {}), source: `git: tracked files in ${d}/` });
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
// With { deadline } (a Date.now() value), it throws DetectDeadline instead of finishing late.
export function detect(root, { suggestions = true, deadline = Infinity } = {}) {
  const ctx = makeCtx(root, deadline);
  const f = ctx.facts;
  const acc = { languages: [], frameworks: [], commands: {}, layout: {}, generated: [], prefer: [], avoid: [] };
  for (const mod of STACKS) {
    if (Date.now() > deadline) throw new DetectDeadline();
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
    frameworks: acc.frameworks.length ? { status: 'found', value: [...acc.frameworks].sort((a, b) => byCodePoint(a.name, b.name)) } : NOT_FOUND,
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
    profile.suggestions = { generated: gen.filter((g) => !isSecretPath(g.path)).sort((a, b) => byCodePoint(a.path, b.path)) };
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
const ver = (x) => `${x.value}${x.kind === 'range' ? ' (a range)' : ''} (${x.source})`;
const fmt = (x, f) => (x?.status === 'found' ? f(x) : 'not found');
export function summaryLines(p) {
  const f = p.facts || {}, c = f.commands || {}, cv = p.conventions || {};
  const cmd = (k) => fmt(c[k], (x) => `${x.run || `${x.defined} (package manager not found)`} (${x.source})`);
  return [
    `- Platform: ${fmt(f.platform, (x) => `${x.value}, ${x.flavour} (${x.source})`)}`,
    `- Languages: ${fmt(f.languages, (x) => x.value.map((l) => l.value).join(', '))} · Node: ${fmt(f.node, ver)} · Python: ${fmt(f.python, ver)}`,
    `- Package manager: ${fmt(f.packageManager, (x) => `${x.value} (${x.source})`)}`,
    `- Build: ${cmd('build')} · Test: ${cmd('test')} · Lint: ${cmd('lint')}`,
    `- Layout: ${fmt(f.layout, (x) => Object.entries(x.value).map(([k, v]) => `${k} ${[].concat(v).join(', ')}`).join('; '))}`,
    `- Rules files: ${fmt(cv.rulesFiles, (x) => x.value.map((r) => r.path).join(', '))} · PR template: ${fmt(cv.prTemplate, (x) => x.path)}`,
    '- A fact marked "not found" isn\'t known: say so, don\'t guess.',
  ];
}

// The session-start grounding (design section 6): the profile's facts with their sources, the rule that the
// project's own rules files win, the guardrails in force, and where the full profile is. `stale` holds the keys
// (as compare() names them) that are out of date. `settings` is the effective settings, or null.
export function groundingText(p, { file, stale = new Set(), settings = null, profileCmd }) {
  const f = p.facts || {}, c = f.commands || {}, cv = p.conventions || {}, g = p.guidance || {};
  const old = (keys, text) => (keys.some((k) => stale.has(k)) ? `${text} [out of date]` : text);
  const cmd = (k) => old([`facts.commands.${k}`], fmt(c[k], (x) => `${x.run || `${x.defined} (package manager not found)`} (${x.source})`));
  const platform = fmt(f.platform, (x) => `${x.value}, ${x.flavour === 'sfra' ? 'SFRA' : x.flavour === 'storefront-next' ? 'Storefront Next' : x.flavour} (${x.source})`)
    + (g.preferSkills?.length ? `. Prefer ${g.preferSkills.join(', ')}` : '') + (g.avoidSkills?.length ? `; don't use ${g.avoidSkills.join(', ')} skills` : '');
  const lines = [
    `[cartwright] Project profile (${file}). These facts were checked against the project at the start of this session; use them instead of guessing or re-reading the files they came from. If AGENTS.md, CLAUDE.md or .cursor/rules say otherwise, follow them. A fact marked "not found" isn't known: say so, don't invent it.`,
    `- Platform: ${old(['facts.platform', 'guidance'], platform)}`,
    `- Languages: ${old(['facts.languages'], fmt(f.languages, (x) => x.value.map((l) => `${l.value} (${l.source})`).join(', ')))} · Node ${old(['facts.node'], fmt(f.node, ver))} · Python ${old(['facts.python'], fmt(f.python, ver))} · package manager ${old(['facts.packageManager'], fmt(f.packageManager, (x) => `${x.value} (${x.source})`))}`,
    `- Build: ${cmd('build')} · Test: ${cmd('test')} · Lint: ${cmd('lint')}`,
    ...(f.otherScripts?.status === 'found' ? [`- Other scripts (${f.otherScripts.source}): ${old(['facts.otherScripts'], f.otherScripts.value.slice(0, 15).join(', ') + (f.otherScripts.value.length > 15 ? ', …' : ''))}`] : []),
    `- Layout: ${old(['facts.layout'], fmt(f.layout, (x) => `${Object.entries(x.value).map(([k, v]) => `${k} ${[].concat(v).join(', ')}`).join('; ')} (${x.source})`))}`,
    `- Rules files: ${old(['conventions.rulesFiles'], fmt(cv.rulesFiles, (x) => x.value.map((r) => r.path).join(', ')))} · PR template: ${old(['conventions.prTemplate'], fmt(cv.prTemplate, (x) => x.path))} · Decision records: ${old(['conventions.adrs'], fmt(cv.adrs, (x) => x.path))} · Tracker: ${old(['conventions.tracker'], fmt(cv.tracker, (x) => `${x.value} (${x.source})`))}${cv.specKit?.status === 'found' ? ` · spec-kit: ${cv.specKit.path}` : ''}`,
  ];
  if (settings) {
    const gen = settings.generated.map((x) => `${x.path} (regenerate: ${x.regenerate || 'not recorded'})`);
    lines.push(`- Guardrails: protected ${settings.protectedBranches.join(', ') || 'none'}; generated ${gen.join(', ') || 'none'}. A blocked action can't be retried another way; tell the person instead.`);
  }
  if (profileCmd) lines.push(`Full profile: ${profileCmd} show --json`);
  return lines.join('\n');
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

// The write command that saves exactly the proposal, for the person to confirm (POSIX shell quoting).
const quote = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${String(v).replace(/'/g, "'\\''")}'`);
export function writeCommand(lists, store = 'folder') {
  const a = ['node', fileURLToPath(import.meta.url), 'write', '--store', store, '--protected', lists.protectedBranches.length ? lists.protectedBranches.join(',') : 'none'];
  if (lists.generated.length) for (const g of lists.generated) a.push('--generated', `${g.path}=${g.regenerate}`); else a.push('--generated', 'none');
  return a.map(quote).join(' ');
}

// --- the command line -------------------------------------------------------------------------------------------
const WRITE_FLAGS = ['--dir', '--store', '--protected', '--generated', '--secrets-allow', '--allow-location', '--protect-location', '--client-project'];
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
    const lists = proposedLists(profile);
    out({ profile, proposedSettings: buildSettings(team, team ? {} : lists), ...(team ? {} : { writeCommand: writeCommand(lists) }), stored: { store: stored.mode, found: stored.found } });
    return;
  }

  if (cmd === 'write') {
    const store = opt('--store');
    if (!store) usage('Choose where to store it: --store folder (default), agents-md or machine.');
    if (!MODES.includes(store)) usage(`--store must be folder, agents-md or machine (got "${store}")`);
    for (let i = 1; i < rest.length; i += 2) if (!WRITE_FLAGS.includes(rest[i - 1]) || rest[i] === undefined) usage(`write doesn't take "${rest[i - 1]}"${WRITE_FLAGS.includes(rest[i - 1]) ? ' without a value' : ''}; its options are ${WRITE_FLAGS.join(', ')}`);
    if (rest.length % 2) usage(`"${rest.at(-1)}" needs a value`);
    const list = (v) => (v === undefined ? undefined : v === 'none' ? [] : v.split(',').map((s) => s.trim()).filter(Boolean));
    // A repeatable list option: undefined when absent, [] for none.
    const repeated = (flag) => { const v = many(flag); return v.length ? v.filter((x) => x !== 'none') : undefined; };
    const generated = repeated('--generated');
    for (const g of generated || []) if (!/^[^=]+=.+$/.test(g)) usage(`--generated takes '<glob>=<regenerate command>' (or none), got "${g}"`);
    const cp = opt('--client-project');
    if (cp !== undefined && !['yes', 'no'].includes(cp)) usage('--client-project takes yes or no');
    const target = load(root, store);
    if (target.settings.status === 'broken') stop(`The existing settings (${target.settings.file}) can't be used: ${target.settings.errors.join('; ')}. Fix or move that file by hand, then run write again.`);
    let base = null;
    for (const s of [target.settings, stored.settings]) {
      if (s.status !== 'ok') continue;
      const v = validateSettings(s.data);
      if (!v.ok && s === target.settings) stop(`The existing settings (${s.file}) can't be used: ${v.errors.join('; ')}. Fix them by hand, then run write again.`);
      if (v.ok) { base = s.data; break; }
    }
    const profile = detect(root);
    // New settings: the person confirms both lists, so they must be on the command line (the command they approve).
    if (!base && (opt('--protected') === undefined || generated === undefined)) {
      const lists = proposedLists(profile);
      const unknown = (profile.suggestions?.generated || []).filter((g) => !g.regenerate).map((g) => g.path);
      usage(`New settings need --protected and --generated (either may be none). Show the person this proposal and run it after their yes, changed as they ask:\n  ${writeCommand(lists, store)}${unknown.length ? `\nAlso suggested as generated, with no known regenerate command (add --generated '<path>=<command>' for any the person confirms): ${unknown.join(', ')}` : ''}`);
    }
    const settings = buildSettings(base, {
      protectedBranches: list(opt('--protected')),
      generated: generated?.map((g) => { const i = g.indexOf('='); return { path: g.slice(0, i).trim(), regenerate: g.slice(i + 1).trim() }; }),
      secretsAllow: repeated('--secrets-allow'),
      allowed: repeated('--allow-location'),
      protect: repeated('--protect-location'),
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
    // An earlier store in lookup order still wins: say so, so the person isn't surprised.
    const all = found(root);
    const active = all[0];
    const where = { folder: 'the .cartwright/ folder', 'agents-md': 'the AGENTS.md section', machine: 'the copy on this machine' };
    out({ store, changed, otherStores: all.filter((m) => m !== store),
      ...(active && active !== store ? { active, note: `${where[active][0].toUpperCase()}${where[active].slice(1)} still takes precedence; remove it to use ${where[store]}.` } : {}) });
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
    out({ store: stored.mode, found: stored.found, ...(stored.notes.length ? { notes: stored.notes } : {}), profile, profileStatus: stored.profile.status === 'ok' && !profile ? 'broken' : stored.profile.status, settings });
    return;
  }
  // check: the cheap version the session start uses (no generated-file search).
  if (!stored.mode) { out({ profiled: false, settings: 'none', ...(stored.notes.length ? { notes: stored.notes } : {}) }); return; }
  const changes = profile ? compare(profile, detect(root, { suggestions: false }), { quick: true }) : [];
  // A profile with no guardrail settings is fine (exit 0), but the profiled rules are off: say so.
  const note = profile && r.status === 'none' ? 'profile present, no guardrail settings: the protected-branch and generated-file rules are off' : undefined;
  out({ profiled: !!profile, store: stored.mode, found: stored.found, upToDate: !!profile && !changes.length, changed: changes.map((c) => c.key), settings: r.status, message: r.message, ...(note ? { note } : {}) });
  process.exit((profile && changes.length) || r.status === 'broken' || (stored.profile.status !== 'none' && !profile) ? 1 : 0);
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) cli(process.argv.slice(2));
