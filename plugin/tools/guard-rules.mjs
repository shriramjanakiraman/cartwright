// Cartwright's guardrails: the rules and the decision, as one pure function, decide(action, ctx). `action` is a
// normalised tool call (guard.mjs turns each agent's payload into one); `ctx` answers every question about the machine
// (the project, its settings, git, files), so the same rules run in the hook, in `guard.mjs explain`, in the tests, and
// later in the auditor. Shipped in the plugin as tools/guard-rules.mjs. No dependencies.
//
// Decisions: allow, deny (with a message that names the rule and says what to do instead), or confirm (only the person
// can approve: guardrail-file changes). See documentation/16-project-profile-and-guardrails.md and decision record 0012.
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { analyse, base, hasFlag, positionals } from './guard-shell.mjs';
import { SECRET_RULES } from './secret-rules.mjs';

export const NO_WORKAROUND = "Don't try another way; if it really must happen, tell the person they can run it themselves.";

// Each rule's scope: universal (every project), profiled (once guardrail settings exist, valid or broken), valid (only
// while the settings are valid), always (can't be switched off). Issue #41 would change a scope here.
export const RULES = {
  secrets: { scope: 'universal', switchable: true },
  'destructive-outside-project': { scope: 'universal', switchable: true },
  'protected-branches': { scope: 'profiled', switchable: true },
  'generated-files': { scope: 'profiled', switchable: true },
  'project-rules': { scope: 'valid', switchable: false },
  'guardrail-files': { scope: 'always', switchable: false },
};

// Readings still with the team lead. These are the design's recommended defaults (decision record 0012); a change of
// reading is a change here.
export const READINGS = {
  // G10: the system's temporary folders count as temporary: $TMPDIR, $TMP, $TEMP, and /tmp and /var/tmp where they exist.
  systemTemp: ['/tmp', '/var/tmp'],
  // G10: the plugin data folder each agent gives counts as Cartwright's cache, as does the state folder.
  pluginData: ['CLAUDE_PLUGIN_DATA', 'COPILOT_PLUGIN_DATA', 'PLUGIN_DATA'],
  // G10: creating a new file or appending outside the project loses no data, so it isn't blocked.
  allowCreateAndAppend: true,
};
// G11 (with the team lead): what counts as switching Cartwright's guardrails off. These need the person's approval.
export const SELF_PROTECTION = {
  command: { agents: ['claude', 'codex', 'copilot'], verbs: ['disable', 'uninstall', 'remove'], plugin: /cartwright/i },
  settingsFiles: [/^\.claude\/settings(\.local)?\.json$/, /^\.github\/copilot\/settings\.json$/, /^\.codex\/config\.toml$/],
  switchOff: [/"disableAllHooks"\s*:\s*true/, /"cartwright@[^"]*"\s*:\s*false/, /\[plugins\."cartwright@[^"]*"\][^[]*enabled\s*=\s*false/],
};
// File names whose commit is blocked whatever they contain (design 5.4), plus other private-key files and dw.json
// (B2C Commerce's instance credentials).
const COMMIT_SECRET_FILES = [/^dw\.json$/, /^\.env$/, /^\.env\.(?!(example|sample|template)$)/, /\.pem$/, /\.key$/, /^id_(rsa|dsa|ecdsa|ed25519)/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/];
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'composer.lock', 'Gemfile.lock', 'Cargo.lock', 'go.sum']);
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// --- globs ------------------------------------------------------------------------------------------------------
// Gitignore-style: ** any folders, * and ? within a name, a pattern without "/" matches at any depth, and a match
// covers everything below it.
export function globToRegExp(glob) {
  let g = String(glob).replace(/^\.\//, '').replace(/\/$/, '');
  const anchored = g.includes('/');
  g = g.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
}
// Branch names: * within a segment, ** across them.
const branchRe = (p) => new RegExp(`^${String(p).split('**').map((x) => x.split('*').map((y) => y.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
export const branchMatches = (patterns, name) => patterns.find((p) => branchRe(p).test(name)) || null;
const inside = (p, dir) => !!p && !!dir && (p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep));

// --- patches (Codex apply_patch, unified diffs) -----------------------------------------------------------------
// The files a patch touches: [{ path, op: create|modify|delete|move, lines: [{ t: ' '|'+'|'-', text }] }].
export function patchTargets(text) {
  const out = [];
  let cur = null, created = false;
  for (const line of String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))) {
    let m;
    if ((m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/))) { cur = { path: m[2].trim(), op: { Add: 'create', Update: 'modify', Delete: 'delete' }[m[1]], lines: [] }; out.push(cur); continue; }
    if ((m = line.match(/^\*\*\* Move to: (.+)$/))) { if (cur) { out.push({ path: m[1].trim(), op: 'create', lines: cur.lines, from: cur.path }); cur.op = 'move'; } continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(line) || line === '*** End of File') continue;
    if ((m = line.match(/^diff --git a\/(.+?) b\/(.+)$/))) { cur = { path: m[2], op: 'modify', lines: [] }; out.push(cur); created = false; continue; }
    if ((m = line.match(/^--- (.+?)(\t.*)?$/)) && !(cur && cur.lines.length && cur.inHunk)) { created = m[1] === '/dev/null'; continue; }
    if ((m = line.match(/^\+\+\+ (.+?)(\t.*)?$/)) && !(cur && cur.inHunk)) {
      const p = m[1].replace(/^b\//, '');
      if (p === '/dev/null') { if (cur) cur.op = 'delete'; continue; }
      if (!cur || cur.path !== p) { cur = { path: p, op: 'modify', lines: [] }; out.push(cur); }
      if (created) cur.op = 'create';
      continue;
    }
    if (/^@@/.test(line)) { if (cur) cur.inHunk = true; continue; }
    if (cur && /^[ +-]/.test(line)) cur.lines.push({ t: line[0], text: line.slice(1) });
  }
  return out.map(({ inHunk, ...t }) => t);
}

// --- git commands -----------------------------------------------------------------------------------------------
const GIT_BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore checkout cherry cherry-pick '
  + 'clean clone commit commit-tree config count-objects describe diff diff-files diff-index diff-tree difftool fetch filter-branch for-each-ref '
  + 'format-patch fsck gc grep hash-object help init log ls-files ls-remote ls-tree maintenance merge merge-base mergetool mv name-rev notes pull '
  + 'push range-diff read-tree rebase reflog remote repack replace reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout '
  + 'stash status submodule switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree write-tree').split(' '));
const GIT_GLOBAL_VALUE = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--exec-path'];

// git's global options and subcommand: { sub, args, cwd, workTree, aliases }. Aliases given on the command line
// (-c alias.<x>=<v>, --config-env=alias.<x>=<ENV>) are collected, because they beat the configured ones.
function gitCall(cmd, env = {}) {
  const a = cmd.argv, aliases = new Map(), pushSpecs = new Map();
  let k = 1, cwd = cmd.cwd, workTree = null;
  while (k < a.length && a[k].text !== null && a[k].text.startsWith('-')) {
    const t = a[k].text, [flag, val] = t.includes('=') ? [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)] : [t, null];
    const value = val ?? (GIT_GLOBAL_VALUE.includes(flag) ? a[++k]?.text ?? null : null);
    if (flag === '-C') cwd = value === null ? null : cwd || isAbsolute(value) ? resolve(cwd || '/', value) : null;
    if (flag === '--work-tree') workTree = value === null ? null : cwd ? resolve(cwd, value) : isAbsolute(value) ? value : null;
    const m = value && (flag === '-c' || flag === '--config-env') && value.match(/^(alias|remote\.[^=]+)\.([^.=]+)=(.*)$/i);
    const v = m && (flag === '-c' ? m[3] : env[m[3]] ?? null);
    if (m && m[1].toLowerCase() === 'alias') aliases.set(m[2], v);
    else if (m && m[2].toLowerCase() === 'push') pushSpecs.set(m[1].slice(7), [...(pushSpecs.get(m[1].slice(7)) || []), v]);
    k++;
  }
  return { sub: a[k]?.text ?? null, args: a.slice(k + 1), cwd, workTree, aliases, pushSpecs, unknownSub: k < a.length && a[k].text === null };
}

// `git config [--local|--global|…] [set|--add] alias.<x> <value>` earlier on the same line: [name, value] or null.
function aliasSet(g) {
  if (g.sub !== 'config') return null;
  const words = g.args.filter((w) => !(w.text && w.text.startsWith('-'))).map((w) => w.text);
  if (words[0] === 'set') words.shift();
  const m = words[0]?.match(/^alias\.(.+)$/i);
  return m && words.length >= 2 ? [m[1], words[1]] : null;
}
// `git config remote.<r>.push <refspec>` earlier on the same line: [remote, refspec] or null.
function pushSet(g) {
  if (g.sub !== 'config') return null;
  const words = g.args.filter((w) => !(w.text && w.text.startsWith('-'))).map((w) => w.text);
  if (words[0] === 'set') words.shift();
  const m = words[0]?.match(/^remote\.(.+)\.push$/i);
  return m && words.length >= 2 ? [m[1], words[1]] : null;
}

// Expand git aliases in place: a plain alias becomes its words; a "!" alias becomes the shell commands it runs.
// An alias given with -c, or set with `git config` earlier on the same line, wins over the configured one.
function expandGit(cmds, ctx, lineAliases = new Map(), linePush = new Map()) {
  const out = [];
  for (let c of cmds) {
    if (c.name !== 'git') { out.push(c); continue; }
    // Under xargs, git gets more arguments from stdin: one unknown word stands for them, so a push can't name its
    // destination and a commit can't name its files.
    if (c.fromXargs) c = { ...c, argv: [...c.argv, { text: null, dynamic: true, glob: false, current: false }] };
    let g = gitCall(c, ctx.env), depth = 0;
    const set = aliasSet(g);
    if (set) lineAliases.set(set[0], set[1]);
    const ps = pushSet(g);
    if (ps) linePush.set(ps[0], [...(linePush.get(ps[0]) || []), ps[1]]);
    // Push refspecs set on the command line or earlier on the line count like configured ones.
    for (const [r, v] of linePush) if (!g.pushSpecs.has(r)) g.pushSpecs.set(r, v);
    while (g.sub && !GIT_BUILTINS.has(g.sub) && depth++ < 5) {
      const alias = g.aliases.has(g.sub) ? g.aliases.get(g.sub) : lineAliases.has(g.sub) ? lineAliases.get(g.sub) : g.cwd ? ctx.gitAlias(g.cwd, g.sub) : null;
      if (!alias) break;
      if (alias.startsWith('!')) {
        const rest = g.args.map((w) => (w.text === null ? '"$UNKNOWN"' : `'${w.text.replace(/'/g, "'\\''")}'`)).join(' ');
        for (const x of analyse(`${alias.slice(1)} ${rest}`, { cwd: g.cwd, env: ctx.env })) out.push(...expandGit([{ ...x, fromAlias: g.sub }], ctx, lineAliases, linePush));
        g = null;
        break;
      }
      const words = analyse(alias, { cwd: g.cwd, env: ctx.env })[0]?.argv || [];
      g = { ...g, sub: words[0]?.text ?? null, args: [...words.slice(1), ...g.args] };
    }
    if (g) out.push({ ...c, git: g });
  }
  return out;
}

// Short option clusters: does `-am` contain `a`?
const shortHas = (args, letter, valueLetters = '') => args.some((w) => {
  const t = w.text;
  if (!t || !/^-[^-]/.test(t)) return false;
  for (const ch of t.slice(1)) { if (ch === letter) return true; if (valueLetters.includes(ch)) return false; }
  return false;
});

// --- what a command writes or deletes ---------------------------------------------------------------------------
const DEV = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// Resolve a word to an absolute path. Symlinks in the folders are followed; the final one only when the path goes
// through it: a write onto it (through), a trailing "/" or "/.", or a glob under it (design 5.3). A plain "rm link"
// judges the link's own name. { path, glob, text } with path null when it can't be known. A glob is judged on its
// fixed leading folder, followed through.
function place(word, cwd, ctx, through = false) {
  if (!word || word.text === null) return { path: null, raw: word };
  let t = word.text, thru = through || /\/\.?$/.test(t), tail = null;
  if (word.glob) { const cut = t.search(/[*?[]/); const head = t.slice(0, cut).replace(/[^/]*$/, ''); tail = t.slice(head.length); t = head || '.'; thru = true; }
  if (!isAbsolute(t) && !cwd) return { path: null, raw: word };
  const abs = isAbsolute(t) ? t : resolve(cwd, t);
  // tail: the glob part after the fixed folder (src/generated/*.ts → *.ts), for matching against generated globs.
  return { path: thru ? ctx.realFull(abs) : ctx.realish(abs), glob: word.glob, text: word.text, tail };
}
const word = (text, glob = false) => ({ text, glob, dynamic: false, current: false });

// What a shell command writes: [{ path, kind }] where kind is overwrite | append | create-or-overwrite | move-src |
// move-dst | link. Paths are absolute (null when unknown).
export function writeTargets(cmd, ctx) {
  const out = [];
  // Writes go through a symlink to the file it points at; moving a file away takes the link itself.
  const add = (w, kind, cwd = cmd.cwd) => out.push({ ...place(w, cwd, ctx, kind !== 'move-src'), kind });
  for (const r of cmd.redirects) {
    if (!r.target || ['<', '<<', '<<<', '<&', '<>'].includes(r.op)) continue;
    if (r.op === '>&' && /^(\d+|-)$/.test(r.target.text || '')) continue;
    if (r.target.text && DEV.test(r.target.text)) continue;
    add(r.target, ['>>', '&>>'].includes(r.op) ? 'append' : 'overwrite');
  }
  const a = cmd.argv, n = cmd.name;
  const pos = (valueOpts) => positionals(a, valueOpts);
  if (n === 'tee') { const append = hasFlag(a, /^(-a|--append|-[a-z]*a[a-z]*)$/); for (const w of pos()) if (!DEV.test(w.text || '')) add(w, append ? 'append' : 'overwrite'); }
  else if (n === 'sed' || n === 'gsed') {
    const ip = a.findIndex((w, k) => k > 0 && w.text && (/^-[a-zA-Z]*i/.test(w.text) && !w.text.startsWith('--') || w.text.startsWith('--in-place')));
    if (ip > 0) {
      const args = a.filter((w, k) => !(k === ip + 1 && a[ip].text === '-i' && w.text === ''));
      const script = hasFlag(args, /^(-e|-f|--expression|--file|-[a-zA-Z]*[ef])/);
      const files = positionals(args, ['-e', '-f', '--expression', '--file', '-l']);
      for (const w of script ? files : files.slice(1)) add(w, 'overwrite');
    }
  } else if (n === 'perl') {
    let inplace = false, code = false;
    const files = [];
    for (let k = 1; k < a.length; k++) {
      const t = a[k].text;
      if (t && /^-[^-]/.test(t)) { if (t.includes('i')) inplace = true; if (/[eE]$/.test(t)) { code = true; k++; } continue; }
      files.push(a[k]);
    }
    if (inplace) for (const w of code ? files : files.slice(1)) add(w, 'overwrite');
  } else if (n === 'awk' || n === 'gawk') {
    const inplace = a.some((w, k) => (w.text === '-i' && a[k + 1]?.text === 'inplace') || w.text === '--include=inplace');
    if (inplace) {
      const prog = hasFlag(a, /^(-f|--file)$/);
      const files = positionals(a, ['-i', '-f', '-v', '--file', '--assign', '--include']).filter((w) => !/^[A-Za-z_]\w*=/.test(w.text || ''));
      for (const w of prog ? files : files.slice(1)) add(w, 'overwrite');
    }
  } else if (n === 'ex' || n === 'ed') { for (const w of pos(['-c', '-s'])) add(w, 'overwrite'); }
  else if (['cp', 'install', 'mv', 'ln', 'rsync'].includes(n)) {
    if (n === 'install' && hasFlag(a, /^(-d|--directory)$/)) return out;
    const values = { cp: ['-t', '--target-directory', '-S', '--suffix'], install: ['-t', '-m', '-o', '-g', '-S', '--mode', '--owner', '--group', '--target-directory'], mv: ['-t', '-S', '--target-directory', '--suffix'], ln: ['-t', '-S', '--target-directory', '--suffix'], rsync: ['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--rsync-path'] }[n];
    const ps = pos(values).filter((w) => !(n === 'rsync' && /^[^/]*:/.test(w.text || '')));
    const ti = a.findIndex((w) => w.text === '-t' || w.text === '--target-directory' || w.text?.startsWith('--target-directory='));
    const dest = ti > 0 ? (a[ti].text.includes('=') ? word(a[ti].text.slice(a[ti].text.indexOf('=') + 1)) : a[ti + 1]) : ps.at(-1);
    const srcs = ti > 0 ? ps : ps.slice(0, -1);
    if (!dest || (!srcs.length && n !== 'ln')) return out;
    if (n === 'mv') for (const s of srcs) add(s, 'move-src');
    const d = place(dest, cmd.cwd, ctx, true);
    const intoDir = d.path && (ctx.isDir(d.path) || ti > 0 || srcs.length > 1 || dest.text?.endsWith('/'));
    const kind = n === 'mv' ? 'move-dst' : n === 'ln' ? 'link' : 'create-or-overwrite';
    if (intoDir && n !== 'rsync') for (const s of srcs) out.push({ path: s.text === null ? null : join(d.path, basename(s.text)), kind });
    else out.push({ ...d, kind });
  } else if (n === 'curl' || n === 'sort') {
    // Output files: curl -o/--output, sort -o/--output.
    for (let k = 1; k < a.length; k++) {
      const t = a[k].text;
      if (t === '-o' || t === '--output') add(a[k + 1], 'overwrite');
      else if (t?.startsWith('--output=')) add(word(t.slice(9)), 'overwrite');
    }
  } else if (n === 'tar' || n === 'bsdtar' || n === 'gtar') {
    // Extracting writes into the -C folder (or the current one).
    const extract = a.slice(1).some((w) => w.text === '--extract' || w.text === '--get' || (w.text && /^-?[a-zA-Z]*x/.test(w.text) && !w.text.startsWith('--')));
    if (extract) {
      const ci = a.findIndex((w) => w.text === '-C' || w.text === '--directory' || w.text?.startsWith('--directory='));
      const d = ci > 0 ? (a[ci].text.includes('=') ? a[ci].text.slice(a[ci].text.indexOf('=') + 1) : a[ci + 1]?.text) : '.';
      out.push(d === null || d === undefined ? { path: null, kind: 'overwrite' } : { ...place(word(`${d.replace(/\/$/, '')}/*`, true), cmd.cwd, ctx, true), kind: 'overwrite' });
    }
  } else if ((n === 'prettier' && hasFlag(a, /^(--write|-w)$/)) || (n === 'eslint' && hasFlag(a, /^--fix$/))) {
    // Formatters that rewrite files in place: each path, a folder meaning everything in it.
    for (const w of positionals(a, ['--config', '-c', '--ignore-path', '--plugin', '--parser', '--ext', '--rule', '--format', '-f', '-o', '--output-file'])) {
      const p = place(w, cmd.cwd, ctx, true);
      if (p.path && !w.glob && ctx.isDir(p.path)) out.push({ ...place(word(`${w.text.replace(/\/$/, '')}/*`, true), cmd.cwd, ctx, true), kind: 'overwrite' });
      else out.push({ ...p, kind: 'overwrite' });
    }
  } else if (n === 'truncate') { for (const w of pos(['-s', '--size', '-r', '--reference'])) add(w, 'overwrite'); }
  else if (n === 'dd') { for (const w of a.slice(1)) if (w.text?.startsWith('of=')) add({ ...w, text: w.text.slice(3) }, 'overwrite'); else if (w.text === null && w.raw?.[0]?.lit?.startsWith('of=')) out.push({ path: null, kind: 'overwrite' }); }
  else if ((n === 'git' && cmd.git?.sub === 'apply') || n === 'patch' || n === 'apply_patch') {
    for (const t of patchFileTargets(cmd, ctx)) out.push(t);
  }
  return out;
}

// The files a git apply / patch / apply_patch command would change, read from the patch (a here-doc, a file in the
// project, or stdin redirected from one). An unreadable patch is one unknown target.
function patchFileTargets(cmd, ctx) {
  const doc = cmd.redirects.find((r) => r.op === '<<' || r.op === '<<<');
  let text = doc ? doc.body ?? doc.target?.text ?? null : undefined;
  if (text === undefined) {
    const from = cmd.redirects.find((r) => r.op === '<')?.target;
    const args = cmd.name === 'git' ? cmd.git.args : cmd.argv.slice(1);
    const iOpt = args.findIndex((w) => w.text === '-i' || w.text === '--input');
    const file = from || (iOpt >= 0 ? args[iOpt + 1] : cmd.name === 'git' ? args.find((w) => w.text && !w.text.startsWith('-')) : null);
    const p = file ? place(file, cmd.git?.cwd ?? cmd.cwd, ctx).path : null;
    text = p && inside(p, ctx.root()) ? ctx.readText(p) : null;
  }
  if (text === null || text === undefined) return [{ path: null, kind: 'overwrite', unknownPatch: true }];
  const cwd = cmd.git?.cwd ?? cmd.cwd;
  const at = (t) => { const abs = resolve(cwd || '/', t.path); return t.op === 'delete' ? ctx.realish(abs) : ctx.realFull(abs); };
  return patchTargets(text).map((t) => ({ path: cwd || isAbsolute(t.path) ? at(t) : null, kind: t.op === 'delete' ? 'delete' : t.op === 'create' ? 'create-or-overwrite' : 'overwrite', patch: t }));
}

// What a shell command deletes: [{ path, recursive }].
export function deleteTargets(cmd, ctx) {
  const a = cmd.argv, n = cmd.name, out = [];
  const add = (w, recursive, through = false, cwd = cmd.cwd) => out.push({ ...place(w, cwd, ctx, through), recursive });
  if (['rm', 'rmdir', 'unlink', 'shred'].includes(n)) {
    const recursive = n === 'rmdir' || hasFlag(a, /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/);
    for (const w of positionals(a, n === 'shred' ? ['-n', '-s', '--iterations', '--size'] : [])) add(w, recursive);
  } else if (n === 'find') {
    const deletes = a.some((w, k) => w.text === '-delete' || (['-exec', '-execdir', '-ok', '-okdir'].includes(w.text) && ['rm', 'unlink', 'shred', 'rmdir'].includes(base(a[k + 1]?.text))));
    // find's start points are searched through: a symlinked start point is followed.
    if (deletes) { const dirs = []; for (let k = 1; k < a.length && !/^[-(!]/.test(a[k].text ?? '-'); k++) dirs.push(a[k]); for (const w of dirs.length ? dirs : [{ text: '.' }]) add(w, true, true); }
  } else if (n === 'rsync' && hasFlag(a, /^--(delete|del|remove-source-files)/)) {
    const ps = positionals(a, ['-e', '--rsh', '--exclude', '--include', '--filter', '-f']).filter((w) => !/^[^/]*:/.test(w.text || ''));
    if (ps.length) add(ps.at(-1), true, true);
  } else if (n === 'git' && cmd.git && (cmd.git.sub === 'clean' || (cmd.git.sub === 'reset' && cmd.git.args.some((w) => w.text === '--hard')))) {
    const tree = cmd.git.workTree || cmd.git.cwd;
    if (cmd.git.workTree || cmd.git.cwd !== cmd.cwd) out.push({ path: tree ? ctx.realFull(tree) : null, recursive: true });
  }
  return out;
}

// --- the rules ----------------------------------------------------------------------------------------------------
const block = (rule, message, extra = {}) => ({ decision: 'deny', rule, message: `Cartwright blocked this (${rule}): ${message}`, ...extra });

// protected-branches: where each `git push` would go.
function checkPush(c, ctx, s) {
  const g = c.git, args = g.args;
  const VALUE = ['--repo', '-o', '--push-option', '--receive-pack', '--exec'];
  const flag = (re) => args.some((w) => w.text && re.test(w.text));
  const ps = positionals([{ text: 'push' }, ...args], VALUE);
  const settingsFile = s.file || 'the project settings';
  const hit = (branch) => {
    const p = branchMatches(s.protectedBranches, branch);
    return p && block('protected-branches', `it would push to ${branch}, a protected branch here (${settingsFile}${p !== branch ? `: ${p}` : ''}). Push your own branch (git push -u origin <branch>) and open a pull request.`);
  };
  if (flag(/^--mirror$/)) return block('protected-branches', `a mirror push overwrites every branch on the remote, including the protected ones (${settingsFile}). Push your own branch and open a pull request.`);
  if (flag(/^--(all|branches)$/)) {
    const local = g.cwd ? ctx.localBranches(g.cwd) : null;
    const p = local === null ? s.protectedBranches[0] : local.find((b) => branchMatches(s.protectedBranches, b));
    if (p) return block('protected-branches', `pushing all branches would push ${p}, a protected branch here (${settingsFile}). Push your own branch (git push -u origin <branch>) and open a pull request.`);
    return null;
  }
  const del = flag(/^(-d|--delete)$/);
  let refspecs = ps.slice(1);
  if (!refspecs.length && !flag(/^--tags$/)) {
    // A push refspec set for the remote (-c remote.<r>.push, git config earlier on the line, or the repo's config)
    // decides where a push without refspecs goes.
    const remote = ps[0] ? ps[0].text : 'origin';
    if (remote === null) return block('protected-branches', "can't tell which remote this push goes to; push with an explicit remote and branch.");
    const specs = g.pushSpecs.get(remote) ?? (g.cwd ? ctx.gitConfigAll(g.cwd, `remote.${remote}.push`) : null);
    if (specs?.length) refspecs = specs.map((v) => (v === null ? { text: null } : word(v)));
  }
  if (!refspecs.length) {
    if (flag(/^--tags$/)) return null;
    const dest = g.cwd ? ctx.pushDestination(g.cwd) : null;
    if (!dest) return block('protected-branches', "can't tell where this push goes; push with an explicit branch name (git push origin <branch>).");
    return hit(dest);
  }
  for (const w of refspecs) {
    if (w.current) { const b = g.cwd ? ctx.currentBranch(g.cwd) : null; const r = b ? hit(b) : block('protected-branches', "can't tell where this push goes; push with an explicit branch name."); if (r) return r; continue; }
    if (w.text === null) return block('protected-branches', "can't tell where this push goes (it depends on a variable or a command); push with an explicit branch name.");
    let t = w.text.replace(/^\+/, '');
    let dst = del ? t : t.includes(':') ? t.slice(t.indexOf(':') + 1) || t.slice(0, t.indexOf(':')) : t;
    if (dst === 'HEAD' || dst === '@') { dst = g.cwd ? ctx.currentBranch(g.cwd) : null; if (!dst) return block('protected-branches', "can't tell which branch HEAD is; push with an explicit branch name."); }
    if (dst.startsWith('refs/tags/')) continue;
    dst = dst.replace(/^refs\/heads\//, '');
    if (!branchMatches(s.protectedBranches, dst)) continue;
    if (g.cwd && ctx.isTagOnly(g.cwd, dst)) continue;
    const r = hit(dst);
    if (r && (del || t.startsWith(':'))) r.message = r.message.replace('it would push to', 'it would delete');
    if (r) return r;
  }
  return null;
}

// What a commit would take can't be known (a variable, a command, xargs): a normal block, not an internal error.
class Unclear extends Error { constructor(m) { super(m); this.unclear = true; } }

// secrets: what a `git commit` would record, including files added earlier on the same line.
function commitContent(c, adds, ctx) {
  const g = c.git;
  if (!g.cwd) throw new Unclear("can't tell which folder this commit runs in");
  const top = ctx.gitTop(g.cwd);
  const lines = [], names = new Set();
  const diff = (args) => {
    const t = ctx.git(g.cwd, 'diff', ...args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--')), '-U0', '--no-color', '--no-ext-diff', '--diff-filter=ACMR', ...(args.includes('--') ? args.slice(args.indexOf('--')) : []));
    if (t === null) return false;
    let file = null, n = 0;
    for (const line of t.split('\n')) {
      let m;
      if ((m = line.match(/^\+\+\+ b\/(.+)$/))) { file = m[1]; names.add(file); continue; }
      if (line.startsWith('Binary files')) { file = null; continue; }
      if ((m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/))) { n = Number(m[1]); continue; }
      if (file && line.startsWith('+') && !line.startsWith('+++')) lines.push({ file, line: n++, text: line.slice(1) });
    }
    return true;
  };
  const args = g.args;
  const all = args.some((w) => w.text === '--all') || shortHas(args, 'a', 'mFCctSu');
  const ps = positionals([{ text: 'commit' }, ...args], ['-m', '--message', '-F', '--file', '-C', '--reuse-message', '-c', '--reedit-message', '--author', '--date', '-t', '--template', '--cleanup', '--trailer', '--fixup', '--squash', '--pathspec-from-file']);
  diff(['--cached']);
  if (all && !diff(['HEAD'])) diff([]);
  if (ps.length) { if (ps.some((w) => w.text === null)) throw new Unclear("can't tell which files this commit takes"); if (!diff(['HEAD', '--', ...ps.map((w) => w.text)])) diff(['--', ...ps.map((w) => w.text)]); }
  for (const a of adds.filter((x) => x.cwd === g.cwd)) {
    if (a.paths === null) throw new Unclear("can't tell which files were added before this commit");
    const paths = a.paths.length ? a.paths : ['.'];
    if (!diff(['HEAD', '--', ...paths])) diff(['--', ...paths]);
    const untracked = (ctx.git(g.cwd, 'ls-files', '-o', '--exclude-standard', '--full-name', '-z', '--', ...paths) || '').split('\0').filter(Boolean);
    for (const f of untracked) {
      names.add(f);
      const text = ctx.readText(join(top, f), MAX_SCAN_BYTES);
      if (text === null || text.includes('\0')) continue;
      text.split('\n').forEach((l, i) => lines.push({ file: f, line: i + 1, text: l }));
      ctx.tick();
    }
  }
  return { lines, names: [...names] };
}

function checkCommit(c, adds, ctx, s) {
  let content;
  try { content = commitContent(c, adds, ctx); } catch (e) { if (e.unclear) return block('secrets', `${e.message} (it depends on a variable, a command or xargs), so it can't be checked for secrets; name the files explicitly.`); throw e; }
  const { lines, names } = content;
  const allowed = (f) => LOCKFILES.has(basename(f)) || s.secretsAllow.some((p) => globToRegExp(p).test(f));
  const named = names.find((f) => !allowed(f) && COMMIT_SECRET_FILES.some((re) => re.test(basename(f))));
  if (named) return block('secrets', `${named} would be committed, and files named like this hold credentials. Unstage it (git restore --staged ${named}), add it to .gitignore, and commit again.`);
  const found = [];
  for (const l of lines) {
    if (allowed(l.file)) continue;
    const kind = (SECRET_RULES.find(([, re]) => re.test(l.text)) || [])[0];
    if (kind) found.push({ ...l, kind });
    if (found.length > 20) break;
  }
  ctx.tick();
  if (!found.length) return null;
  const f = found[0];
  return block('secrets', `${f.file}:${f.line} looks like a ${f.kind}${found.length > 1 ? ` (and ${found.length - 1} more)` : ''}. The value isn't shown. Remove it (use an environment variable or the project's secret store), unstage it, and commit again. If it's a deliberate test fake, the team can allow that path in the settings through a pull request.`);
}

// Where a path is, for the destructive rule: protected, inside (the project), temp, cache, allowed, or outside.
function placeOf(p, ctx, s) {
  const L = ctx.locations(s);
  if (L.protected.some((d) => inside(p, d))) return 'protected';
  if (inside(p, ctx.root())) return 'inside';
  if (L.temp.some((d) => inside(p, d))) return 'temp';
  if (L.cache.some((d) => inside(p, d))) return 'cache';
  if (L.allowed.some((d) => inside(p, d))) return 'allowed';
  return 'outside';
}
function destructive(p, verb, ctx, s) {
  if (p === null) return block('destructive-outside-project', `can't tell where this ${verb} points (it depends on a variable or a command); use an explicit path.`);
  const where = placeOf(p, ctx, s);
  if (where === 'protected') return block('destructive-outside-project', `it would ${verb} ${p}, which the team protects (locations.protected in ${s.file}).`);
  if (where !== 'outside') return null;
  return block('destructive-outside-project', `it would ${verb} ${p}, which is outside this project, the temporary folder and Cartwright's cache. Work inside the project, or ask the person to run it themselves. If the team works there routinely, they can add it to locations.allowed in the settings through a pull request.`);
}

// Guardrail files: the settings and profile, the .cartwright/ folder, the AGENTS.md section, the machine-mode files.
// A write onto one of them, by exact path.
function guardrailPath(p, ctx) {
  if (!p) return null;
  const cw = join(ctx.root(), '.cartwright');
  for (const f of ['settings.json', 'profile.json']) if (p === join(cw, f)) return `.cartwright/${f}`;
  if (p === cw) return 'the .cartwright/ folder';
  if (inside(p, join(ctx.stateDir(), 'projects')) && /\/(settings|profile)\.json$/.test(p)) return p;
  return null;
}
// The glob part of a pattern: the name segment holding its first wildcard.
const globSegment = (text) => { const cut = text.search(/[*?[]/); return text.slice(text.lastIndexOf('/', cut) + 1).split('/')[0]; };
// Would deleting (or moving away) target t remove the file or folder at x? A folder goes only with a recursive
// delete or a move; a glob covers a name only if it matches it, and a hidden name only if the pattern starts with
// "." (as the shell does).
function removes(t, x) {
  if (!t.path || !x) return false;
  if (t.path === x) return true;
  if (!inside(x, t.path)) return false;
  const rel = relative(t.path, x), name = rel.split(sep)[0];
  if (t.glob) {
    const seg = globSegment(t.text || '');
    if ((name.startsWith('.') && !seg.startsWith('.')) || !globToRegExp(seg).test(name)) return false;
    return rel === name || !!t.recursive;
  }
  return !!t.recursive;
}
// What a delete or move would take away of the guardrail files, or null. Folders count only if they exist.
function guardrailRemoved(t, ctx) {
  const cw = join(ctx.root(), '.cartwright'), projects = join(ctx.stateDir(), 'projects');
  for (const f of ['settings.json', 'profile.json']) if (removes(t, join(cw, f)) && ctx.exists(join(cw, f))) return `.cartwright/${f}`;
  if (ctx.exists(cw) && removes(t, cw)) return 'the .cartwright/ folder';
  if (ctx.exists(projects) && removes(t, projects)) return `${projects} (Cartwright's machine-only settings)`;
  if (t.path && inside(t.path, projects) && /\/(settings|profile)\.json$/.test(t.path)) return t.path;
  return null;
}
const confirm = (what, how) => ({ decision: 'confirm', rule: 'guardrail-files', what, how });

// G5: guardrail paths changed through git or permissions. The guardrail paths: the .cartwright/ folder (when it
// exists) and, in AGENTS.md mode, AGENTS.md. Returns what a command would change, or null.
const PERMISSION_COMMANDS = { chmod: 1, chown: 1, chgrp: 1, chflags: 1, setfacl: 0, xattr: 0 };
function guardrailByGitOrPermissions(c, ctx, sec) {
  const root = ctx.root(), cw = join(root, '.cartwright');
  const paths = [...(ctx.exists(cw) ? [cw] : []), ...(sec ? [sec.path] : [])];
  if (!paths.length) return null;
  const label = (p) => (p === cw ? 'the .cartwright/ folder' : `the Cartwright section of ${relative(root, p)}`);
  // A path names a guardrail path exactly or inside it ("explicit"), or is a folder above one ("above").
  const hit = (p) => { for (const g of paths) { if (p && (p === g || inside(p, g))) return { g, explicit: true }; if (p && inside(g, p)) return { g, explicit: false }; } return null; };
  const at = (w, cwd) => place(w, cwd, ctx).path;
  // Would the command destroy content in the guardrail paths that isn't committed? One git status, on those paths only.
  const dirty = (cwd, kinds) => {
    const out = ctx.git(cwd, 'status', '--porcelain', '--ignored', '--untracked-files=all', '--', ...paths);
    if (out === null) return true;
    return out.split('\n').filter(Boolean).some((l) => kinds.includes(l.startsWith('??') ? 'untracked' : l.startsWith('!!') ? 'ignored' : 'tracked'));
  };
  if (c.name in PERMISSION_COMMANDS) {
    const ps = positionals(c.argv, ['--reference', '-f', '-h', '-n', '-m', '-x', '-w', '-d']).slice(c.argv.some((w) => w.text?.startsWith('--reference')) ? 0 : PERMISSION_COMMANDS[c.name]);
    const recursive = hasFlag(c.argv, /^(-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/);
    for (const w of ps) { const h = hit(at(w, c.cwd)); if (h && (h.explicit || recursive)) return `${label(h.g)} (${c.name} changes who can read or change it)`; }
    return null;
  }
  if (c.name !== 'git' || !c.git) return null;
  const g = c.git, a = g.args, cwd = g.cwd;
  if (!cwd) return null;
  const has = (re) => a.some((w) => w.text && re.test(w.text));
  const afterDashes = () => { const i = a.findIndex((w) => w.text === '--'); return i < 0 ? null : a.slice(i + 1); };
  if (g.sub === 'rm' || g.sub === 'mv') {
    const ps = positionals([{ text: g.sub }, ...a], []);
    for (const w of g.sub === 'mv' ? ps.slice(0, -1) : ps) { const h = hit(at(w, cwd)); if (h && (h.explicit || g.sub === 'mv' || has(/^-[a-zA-Z]*r/))) return `${label(h.g)} (git ${g.sub})`; }
    return null;
  }
  if (g.sub === 'restore' || (g.sub === 'checkout' && afterDashes())) {
    // Putting back an older version of the settings can loosen them, so it's a change, not a restore.
    if (g.sub === 'restore' && has(/^(-S|--staged)$/) && !has(/^(-W|--worktree)$/)) return null;
    const ps = g.sub === 'checkout' ? afterDashes() : positionals([{ text: 'restore' }, ...a], ['-s', '--source']);
    for (const w of ps) {
      const h = hit(at(w, cwd));
      if (h?.explicit) return `${label(h.g)} (git ${g.sub} puts back another version)`;
      if (h && dirty(cwd, ['tracked'])) return `${label(h.g)} (git ${g.sub} would discard its uncommitted changes)`;
    }
    return null;
  }
  // Sweeping commands: only when they'd destroy guardrail content that isn't committed.
  if (g.sub === 'stash' && !['list', 'show', 'branch', 'create', 'store'].includes(a[0]?.text)) {
    const kinds = ['tracked', ...(has(/^(-u|--include-untracked|-a|--all)$/) ? ['untracked'] : []), ...(has(/^(-a|--all)$/) ? ['ignored'] : [])];
    return dirty(cwd, kinds) ? `${paths.map(label).join(' and ')} (git stash would put away its uncommitted changes)` : null;
  }
  if (g.sub === 'clean' && has(/^(-[a-zA-Z]*f|--force)/)) {
    const kinds = has(/^-[a-zA-Z]*X/) ? ['ignored'] : has(/^-[a-zA-Z]*x/) ? ['untracked', 'ignored'] : ['untracked'];
    return dirty(cwd, kinds) ? `${paths.map(label).join(' and ')} (git clean would delete files in it that aren't committed)` : null;
  }
  if ((g.sub === 'reset' && has(/^--hard$/)) || (g.sub === 'checkout' && has(/^(-f|--force)$/))) {
    return dirty(cwd, ['tracked']) ? `${paths.map(label).join(' and ')} (git ${g.sub} would discard its uncommitted changes)` : null;
  }
  return null;
}

// The AGENTS.md section, when this project keeps its settings there: { path, text, start, end } or null.
function agentsSection(ctx) {
  const a = ctx.agentsSection();
  return a && a.start !== undefined ? a : null;
}
const overlaps = (text, needle, start, end) => {
  if (!needle) return false;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) if (i < end && i + needle.length > start) return true;
  return false;
};
function editTouchesSection(t, sec) {
  const body = sec.text.slice(sec.start, sec.end);
  if (t.op === 'delete' || t.op === 'move') return true;
  if (t.content !== undefined) { const i = t.content.indexOf(body); return i < 0; }
  if (t.edits) return t.edits.some((e) => overlaps(sec.text, e.before, sec.start, sec.end) || (e.before === '' && e.after?.includes('cartwright')));
  if (t.patch) {
    const outside = sec.text.slice(0, sec.start) + sec.text.slice(sec.end);
    return t.patch.lines.some((l) => (l.t === '-' && l.text.trim() && body.includes(l.text)) || /cartwright[:-]/.test(l.text)
      || (l.t === ' ' && l.text.trim() && body.includes(l.text) && !outside.includes(l.text)));
  }
  return true;
}

// --- decide -------------------------------------------------------------------------------------------------------
// Everything the rules look at, worked out once: the shell commands (aliases expanded) and the edit targets.
export function prepare(action, ctx) {
  const cmds = [], edits = [];
  for (const a of action.actions) {
    if (a.type === 'shell') cmds.push(...expandGit(analyse(a.command, { cwd: ctx.cwd(), env: ctx.env }), ctx));
    else if (a.type === 'edit') {
      for (const t of a.targets) {
        // An edit through a symlink changes the file it points at; deleting one removes the link.
        const abs = t.path ? (isAbsolute(t.path) ? t.path : resolve(ctx.cwd() || '/', t.path)) : null;
        const path = abs ? (t.op === 'delete' ? ctx.realish(abs) : ctx.realFull(abs)) : null;
        const op = t.op === 'write' ? (path && ctx.exists(path) ? 'modify' : 'create') : t.op;
        edits.push({ ...t, path, op, existed: path ? ctx.exists(path) : false });
      }
    }
  }
  return { cmds, edits, line: action.actions.filter((a) => a.type === 'shell').map((a) => a.command).join('\n') };
}

const isGit = (c, sub) => c.name === 'git' && c.git?.sub === sub;
// Does the action touch a rule's family at all? Used when a rule fails: a matched family is denied, others allowed.
const FAMILY = {
  secrets: (A) => A.cmds.some((c) => isGit(c, 'commit')),
  'protected-branches': (A) => A.cmds.some((c) => isGit(c, 'push')),
  'generated-files': (A) => A.edits.length > 0 || A.cmds.some((c) => c.redirects.length || /^(tee|sed|perl|awk|cp|mv|install|ln|rsync|truncate|dd|patch|apply_patch|ex|ed)$/.test(c.name) || isGit(c, 'apply')),
  'destructive-outside-project': (A) => A.edits.length > 0 || A.cmds.some((c) => c.redirects.length || /^(rm|rmdir|unlink|shred|find|rsync|mv|cp|install|ln|dd|truncate|tee|sed|perl)$/.test(c.name) || isGit(c, 'clean') || isGit(c, 'reset')),
  'guardrail-files': (A) => A.edits.length > 0 || A.cmds.some((c) => c.redirects.length || /^(rm|rmdir|unlink|shred|find|rsync|mv|cp|install|ln|dd|truncate|tee|sed|perl|awk|patch|apply_patch|ex|ed|claude|codex|copilot|chmod|chown|chgrp|chflags|setfacl|xattr)$/.test(c.name) || /profile\.mjs/.test(c.text) || ['clean', 'apply', 'rm', 'mv', 'restore', 'checkout', 'stash', 'reset'].some((x) => isGit(c, x))),
  'project-rules': () => true,
};

const CHECKS = {
  secrets(A, ctx, s) {
    const adds = [];
    for (const c of A.cmds) {
      if (isGit(c, 'add')) {
        const ps = positionals([{ text: 'add' }, ...c.git.args], ['--chmod', '--pathspec-from-file']);
        const all = c.git.args.some((w) => ['-A', '--all', '-u', '--update'].includes(w.text));
        adds.push({ cwd: c.git.cwd, paths: ps.some((w) => w.text === null) ? null : all ? [] : ps.map((w) => w.text) });
      }
      if (isGit(c, 'commit')) { const r = checkCommit(c, adds, ctx, s); if (r) return r; }
    }
    return null;
  },
  'protected-branches'(A, ctx, s) {
    for (const c of A.cmds) if (isGit(c, 'push')) { const r = checkPush(c, ctx, s); if (r) return r; }
    return null;
  },
  'generated-files'(A, ctx, s) {
    if (!s.generated.length) return null;
    const root = ctx.root();
    // A glob target matches when the generated glob covers its pattern (src/generated/*.ts under src/generated/**).
    const match = (p, tail) => {
      if (!p || !inside(p, root)) return null;
      const rel = relative(root, p);
      return s.generated.find((g) => globToRegExp(g.path).test(rel) || (tail && globToRegExp(g.path).test(rel ? `${rel}/${tail}` : tail)));
    };
    const say = (rel, g) => block('generated-files', `${rel} is generated (${s.file}: ${g.path}). Don't edit it by hand: change its source and ${g.regenerate ? `run ${g.regenerate}` : "regenerate it (the regenerate command isn't recorded while the settings are broken; fix the settings)"}.`);
    for (const e of A.edits) {
      if (!e.path) return block('generated-files', "couldn't tell which file this edits, so it can't be checked against the generated files; name the file explicitly.");
      const g = match(e.path);
      if (g) return say(relative(root, e.path), g);
    }
    for (const c of A.cmds) {
      for (const t of writeTargets(c, ctx)) {
        if (t.kind === 'move-src' || t.kind === 'delete') continue;
        if (t.unknownPatch) return block('generated-files', "couldn't read the patch to check it against the generated files; apply it from a file in the project, or as a here-document.");
        if (t.path === null) continue;
        const g = match(t.path, t.glob ? t.tail : null);
        if (g) return say(relative(root, t.path), g);
      }
    }
    return null;
  },
  'destructive-outside-project'(A, ctx, s) {
    for (const c of A.cmds) {
      for (const t of deleteTargets(c, ctx)) { const r = destructive(t.path, 'delete', ctx, s); if (r) return r; }
      for (const t of writeTargets(c, ctx)) {
        if (t.kind === 'move-src') { const r = destructive(t.path, 'move away', ctx, s); if (r) return r; continue; }
        if (t.kind === 'delete') { const r = destructive(t.path, 'delete', ctx, s); if (r) return r; continue; }
        if (t.kind === 'append' && READINGS.allowCreateAndAppend) continue;
        // Overwriting loses data only when the file exists; creating a new file doesn't (G10).
        if (t.path !== null && READINGS.allowCreateAndAppend && !ctx.exists(t.path)) continue;
        const r = destructive(t.path, 'overwrite', ctx, s); if (r) return r;
      }
    }
    for (const e of A.edits) {
      if (!e.path) continue;
      if (READINGS.allowCreateAndAppend && !e.existed) continue;
      const r = destructive(e.path, e.op === 'delete' || e.op === 'move' ? 'delete' : 'overwrite', ctx, s); if (r) return r;
    }
    return null;
  },
  'project-rules'(A, ctx, s) {
    const root = ctx.root();
    for (const r of s.rules) {
      const msg = () => block('project-rules', `${r.message} (rule "${r.id}" in ${s.file})`, { rule: `project-rules:${r.id}` });
      if (r.shell) {
        const re = new RegExp(r.shell);
        if (re.test(A.line) || A.cmds.some((c) => re.test(c.text))) return msg();
      }
      if (r.paths) {
        const res = r.paths.map(globToRegExp);
        const hit = (p) => p && inside(p, root) && res.some((re) => re.test(relative(root, p)));
        if (A.edits.some((e) => hit(e.path)) || A.cmds.some((c) => writeTargets(c, ctx).some((t) => t.kind !== 'move-src' && hit(t.path)))) return msg();
      }
    }
    return null;
  },
  'guardrail-files'(A, ctx) {
    const root = ctx.root();
    const sec = agentsSection(ctx);
    for (const e of A.edits) {
      const g = guardrailPath(e.path, ctx);
      if (g) return confirm(g, 'edit');
      if (sec && e.path === sec.path && editTouchesSection(e, sec)) return confirm(`the Cartwright section of ${relative(root, sec.path)}`, 'edit');
      if (e.path && inside(e.path, root) && SELF_PROTECTION.settingsFiles.some((re) => re.test(relative(root, e.path)))) {
        const after = [e.content, ...(e.edits || []).map((x) => x.after), ...(e.patch?.lines || []).filter((l) => l.t === '+').map((l) => l.text)].filter(Boolean).join('\n');
        if (SELF_PROTECTION.switchOff.some((re) => re.test(after))) return confirm(`${relative(root, e.path)} (it would switch Cartwright's hooks or plugin off)`, 'edit');
      }
    }
    for (const c of A.cmds) {
      const sp = SELF_PROTECTION.command;
      if (sp.agents.includes(c.name) && c.argv[1]?.text === 'plugin' && sp.verbs.includes(c.argv[2]?.text) && c.argv.slice(3).some((w) => w.text === null || sp.plugin.test(w.text))) return confirm('the Cartwright plugin (it would switch its guardrails off)', 'shell');
      const pm = c.argv.findIndex((w) => /(^|\/)profile\.mjs$/.test(w.text || ''));
      if (pm >= 0 && ['write', 'refresh'].includes(c.argv[pm + 1]?.text)) return confirm("the project's profile and guardrail settings", 'shell');
      const gone = [...deleteTargets(c, ctx), ...writeTargets(c, ctx).filter((t) => t.kind === 'move-src').map((t) => ({ ...t, recursive: true }))];
      for (const t of gone) { const g = guardrailRemoved(t, ctx); if (g) return confirm(g, 'shell'); }
      for (const t of writeTargets(c, ctx)) {
        if (t.kind === 'move-src') continue;
        const g = guardrailPath(t.path, ctx);
        if (g) return confirm(g, 'shell');
        if (sec && t.path === sec.path) return confirm(`the Cartwright section of ${relative(root, sec.path)} (a shell write to it counts as changing the section)`, 'shell');
      }
      if (sec) for (const t of gone) if (removes(t, sec.path)) return confirm(`the Cartwright section of ${relative(root, sec.path)}`, 'shell');
      const viaGit = guardrailByGitOrPermissions(c, ctx, sec);
      if (viaGit) return confirm(viaGit, 'shell');
    }
    return null;
  },
};
const ORDER = ['secrets', 'protected-branches', 'generated-files', 'destructive-outside-project', 'project-rules', 'guardrail-files'];

// Is a rule on for this project, with these settings?
function active(rule, s) {
  const r = RULES[rule];
  if (r.scope === 'profiled' && s.status === 'none') return false;
  if (r.scope === 'valid' && s.status !== 'ok') return false;
  return !r.switchable || s.guardrails[rule] !== false;
}

// The settings as the rules see them, with defaults for an unprofiled project.
export function ruleSettings(resolved, file) {
  const e = resolved.settings;
  return {
    status: resolved.status, file: file || 'the project settings', message: resolved.message, loosening: resolved.loosening || [],
    guardrails: e?.guardrails || {}, protectedBranches: e?.protectedBranches || [], generated: e?.generated || [],
    secretsAllow: e?.secrets?.allow || [], allowed: e?.locations?.allowed || [], protected: e?.locations?.protected || [], rules: e?.rules || [],
  };
}

// The decision for one tool call. Returns { decision: allow|deny|confirm, rule, message, what?, how? }.
export function decide(action, ctx) {
  const s = ctx.settings();
  let A;
  try { A = prepare(action, ctx); } catch (e) {
    const line = action.actions.map((a) => a.command || '').join(' ');
    if (/\bgit\b[^\n]*\b(push|commit)\b|\b(rm|mv|cp|dd|truncate|shred)\b|>/.test(line) || action.actions.some((a) => a.type === 'edit')) return finish({ decision: 'deny', rule: 'guard', message: couldNot(e) }, s);
    return { decision: 'allow', rule: null, note: `Cartwright couldn't read this command (${e.message}); it was allowed.` };
  }
  if (A.cmds.some((c) => c.tooDeep)) return finish({ decision: 'deny', rule: 'guard', message: "Cartwright blocked this: it's nested too deeply to check (more than six levels of sh -c, eval or command substitution). Run the inner command directly." }, s);
  let confirmed = null;
  for (const rule of ORDER) {
    if (!active(rule, s)) continue;
    let r;
    try { r = CHECKS[rule](A, ctx, s); } catch (e) {
      if (FAMILY[rule](A)) r = { decision: 'deny', rule, message: e.deadline ? `Cartwright blocked this (${rule}): it's too large to check in time; ${rule === 'secrets' ? 'commit in smaller parts' : 'split it into smaller steps'}.` : couldNot(e, rule) };
      else continue;
    }
    if (!r) continue;
    if (r.decision === 'deny') return finish(r, s);
    confirmed ||= r;
  }
  return confirmed ? finish(confirmed, s) : { decision: 'allow', rule: null };
}
const couldNot = (e, rule) => `Cartwright couldn't check this safely${rule ? ` (${rule})` : ''} (${e.message}); the person can run it themselves, and please report it.`;

// Every block ends the same way: the broken-settings warning when it applies, the personal-file note when that file
// tried to switch this rule off, and the no-workaround sentence.
function finish(r, s) {
  const notes = [];
  if (s.status === 'broken' && s.message) notes.push(s.message);
  if (s.loosening.some((l) => l.startsWith(`guardrails.${r.rule}:`))) notes.push('Your personal file tries to switch this off; the personal file can only add or tighten rules.');
  if (r.decision !== 'deny') return { ...r, notes };
  return { ...r, notes, message: [r.message, ...notes, NO_WORKAROUND].join(' ') };
}

// The message for a guardrail-file change when the agent's own approval prompt can't be used (or isn't verified).
export function confirmAsDeny(r, { command, store, plugin }) {
  const how = r.how === 'shell' && command
    ? `give them this command to run in their own terminal: ${command}`
    : `ask them to make this change themselves, or to run node "${plugin}/tools/profile.mjs" write --store ${store || 'folder'} with the lists they confirm`;
  return [`Cartwright blocked this (guardrail-files): it changes ${r.what}, and only the person can approve changes to the guardrail settings. Show them the change and ${how}.`, ...(r.notes || []), NO_WORKAROUND].join(' ');
}
// The reason shown in the agent's own approval prompt, where that prompt is used.
export const confirmReason = (r) => [`Cartwright: this changes ${r.what}. Only approve it if you asked for this change.`, ...(r.notes || [])].join(' ');
