// A small POSIX shell reader for the guard: enough to find what a command line would push, commit, write or delete,
// without running anything. It tokenises with shell quoting (single and double quotes, backslashes), splits simple
// commands on ; && || | & newlines and parentheses, keeps redirections and here-documents, and records $VAR, ${VAR},
// $(…) and backticks so they can be resolved (or flagged as unknown) later. Shipped in the plugin as
// tools/guard-shell.mjs. No dependencies. It is command matching, not a shell: a guardrail, not a boundary.

// Reserved words that open or close a compound command: at the start of a command they're skipped, so
// `if true; then git push; fi` is read as `true` and `git push`. A for, select or case header is a word list, not a
// command, so it's dropped whole.
const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'in', 'esac', 'function', '{', '}', '!', '[[', ']]']);
const HEADERS = new Set(['for', 'select', 'case']);
import { dirname, resolve as resolvePath } from 'node:path';

const OUT_OPS = ['&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '>', '<'];
const CTL_OPS = ['&&', '||', '|&', ';;', '|', '&', ';', '(', ')'];
const PLAIN_END = /[\s'"\\$`<>&|;()]/;

// The index just past the parenthesis that closes the one opened before `i`, skipping quotes and nested pairs; past
// the end (src.length + 1) when it's never closed, so an unterminated $(… keeps all its text.
function closeParen(src, i) {
  let depth = 1, q = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return src.length + 1;
}

// Backslash escapes as bash's $'…', echo -e and printf %b decode them (\n \t \\ \' \" \xHH \NNN \0NNN \e …).
export function decodeEscapes(s) {
  const named = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
  return String(s).replace(/\\(x[0-9A-Fa-f]{1,2}|0?[0-7]{1,3}|u[0-9A-Fa-f]{1,4}|.)/g, (m, e) => {
    if (e[0] === 'x' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e[0] === 'u' && e.length > 1) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return named[e] ?? m;
  });
}

// One $… expansion starting at src[i]: a segment and the index after it.
function dollar(src, i) {
  const n = src[i + 1];
  // $'…' (ANSI-C quoting): a literal with backslash escapes decoded.
  if (n === "'") {
    let j = i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
    return [{ lit: decodeEscapes(src.slice(i + 2, j)), q: true }, Math.min(j + 1, src.length)];
  }
  if (src.startsWith('$((', i)) { const j = closeParen(src, i + 2); return [{ dyn: 'arithmetic' }, Math.min(src.length, j + 1)]; }
  if (n === '(') { const j = closeParen(src, i + 2); return [{ cmd: src.slice(i + 2, j - 1) }, Math.min(j, src.length)]; }
  if (n === '{') {
    const j = src.indexOf('}', i + 2), body = src.slice(i + 2, j < 0 ? src.length : j);
    const m = body.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
    return [m ? { v: body } : { dyn: 'parameter' }, j < 0 ? src.length : j + 1];
  }
  const m = src.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (m) return [{ v: m[0] }, i + 1 + m[0].length];
  if (n && /[0-9@*#?$!-]/.test(n)) return [{ dyn: 'special' }, i + 2];
  return [{ lit: '$', q: false }, i + 1];
}

// Tokens: { t: 'w', segs } words, { t: 'op', op } separators, { t: 'r', op, fd } redirections, { t: 'h', … } here-docs.
export function lex(src) {
  const toks = [], heredocs = [];
  let segs = null, i = 0;
  const flush = () => { if (segs) { toks.push({ t: 'w', segs }); segs = null; } };
  const lit = (s, q) => (segs ||= []).push({ lit: s, q });
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { if (src[i + 1] === '\n') { i += 2; continue; } lit(src[i + 1] ?? '', true); i += 2; continue; }
    if (c === "'") { const j = src.indexOf("'", i + 1), e = j < 0 ? src.length : j; lit(src.slice(i + 1, e), true); i = e + 1; continue; }
    if (c === '"') {
      segs ||= [];
      let j = i + 1, buf = '';
      const push = () => { if (buf) { lit(buf, true); buf = ''; } };
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1])) { if (src[j + 1] !== '\n') buf += src[j + 1]; j += 2; continue; }
        if (src[j] === '$') { push(); const [seg, k] = dollar(src, j); segs.push(seg.lit ? { lit: '$', q: true } : seg); j = k; continue; }
        if (src[j] === '`') { push(); const k = src.indexOf('`', j + 1), e = k < 0 ? src.length : k; segs.push({ cmd: src.slice(j + 1, e) }); j = e + 1; continue; }
        buf += src[j++];
      }
      push();
      if (!segs.length) lit('', true);
      i = j + 1;
      continue;
    }
    if (c === '$') { const [seg, j] = dollar(src, i); (segs ||= []).push(seg); i = j; continue; }
    if (c === '`') { const j = src.indexOf('`', i + 1), e = j < 0 ? src.length : j; (segs ||= []).push({ cmd: src.slice(i + 1, e) }); i = e + 1; continue; }
    if (c === '#' && !segs) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '\n') {
      flush(); toks.push({ t: 'op', op: '\n' }); i++;
      // Here-document bodies start on the next line and end at their delimiter.
      while (heredocs.length) {
        const h = heredocs.shift(), lines = [];
        while (i < src.length) {
          const e = src.indexOf('\n', i), line = src.slice(i, e < 0 ? src.length : e);
          i = e < 0 ? src.length : e + 1;
          if ((h.op === '<<-' ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === h.delim) break;
          lines.push(line);
        }
        h.body = lines.join('\n');
      }
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      let fd = null;
      if (segs && segs.length === 1 && /^\d$/.test(segs[0].lit || '') && !segs[0].q) { fd = segs[0].lit; segs = null; } else flush();
      const op = OUT_OPS.find((o) => src.startsWith(o, i));
      i += op.length;
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        let j = i; while (j < src.length && !/[\s;&|<>()]/.test(src[j])) j++;
        const raw = src.slice(i, j);
        const tok = { t: 'h', op, delim: raw.replace(/['"\\]/g, ''), quoted: /['"\\]/.test(raw), body: '' };
        toks.push(tok); heredocs.push(tok); i = j;
        continue;
      }
      toks.push({ t: 'r', op, fd });
      continue;
    }
    const ctl = CTL_OPS.find((o) => src.startsWith(o, i));
    if (ctl) { flush(); toks.push({ t: 'op', op: ctl }); i += ctl.length; continue; }
    let j = i + 1; while (j < src.length && !PLAIN_END.test(src[j])) j++;
    lit(src.slice(i, j), false); i = j;
  }
  flush();
  return toks;
}

// Simple commands: { words, assigns: [{ name, segs }], redirects: [{ op, fd, target, body }], piped } where piped
// means the command reads the previous one's output through a pipe.
export function parse(src) {
  const toks = lex(src), cmds = [];
  let cur = { words: [], assigns: [], redirects: [] };
  const end = () => { if (cur.words.length || cur.assigns.length || cur.redirects.length) cmds.push(cur); cur = { words: [], assigns: [], redirects: [] }; };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === 'op') { end(); if (tk.op === '|' || tk.op === '|&') cur.piped = true; continue; }
    if (tk.t === 'h') { cur.redirects.push({ op: '<<', body: tk }); continue; }
    if (tk.t === 'r') { const target = toks[k + 1]?.t === 'w' ? toks[++k].segs : null; cur.redirects.push({ op: tk.op, fd: tk.fd, target }); continue; }
    const first = tk.segs[0];
    const word = tk.segs.length === 1 && first.lit !== undefined && !first.q ? first.lit : null;
    // A standalone { or } opens or closes a group (function p { …; }, coproc p { …; }): it ends the command before it.
    if (word === '{' || word === '}') { end(); continue; }
    if (cur.header) continue;
    if (!cur.words.length && !cur.assigns.length && word !== null) {
      if (RESERVED.has(word)) continue;
      if (HEADERS.has(word)) { cur.header = true; continue; }
    }
    const m = !cur.words.length && first?.lit !== undefined && !first.q ? first.lit.match(/^([A-Za-z_][A-Za-z0-9_]*)=/) : null;
    if (m) { cur.assigns.push({ name: m[1], segs: [{ lit: first.lit.slice(m[0].length), q: false }, ...tk.segs.slice(1)] }); continue; }
    cur.words.push(tk.segs);
  }
  end();
  return cmds;
}

// Substitutions that are known to print the current branch, so a push using them can still be judged.
export const CURRENT_BRANCH = [/^\s*git\s+branch\s+--show-current\s*$/, /^\s*git\s+rev-parse\s+--abbrev-ref\s+HEAD\s*$/, /^\s*git\s+symbolic-ref\s+--short\s+HEAD\s*$/];

// A word's value: { text, dynamic, glob, current } where text is null when part of it can't be known.
export function evalWord(segs, vars, env) {
  let text = '', dynamic = false, glob = false, current = false;
  segs.forEach((s, idx) => {
    if (s.lit !== undefined) {
      let t = s.lit;
      if (idx === 0 && !s.q && /^~(\/|$)/.test(t)) t = (env.HOME || '~') + t.slice(1);
      else if (idx === 0 && !s.q && /^~[^/]/.test(t)) dynamic = true;
      if (!s.q && /[*?[]/.test(t)) glob = true;
      text += t;
    } else if (s.v !== undefined) {
      const val = vars.has(s.v) ? vars.get(s.v) : env[s.v];
      if (val === undefined || val === null) dynamic = true; else text += val;
    } else if (s.cmd !== undefined) {
      if (segs.length === 1 && CURRENT_BRANCH.some((re) => re.test(s.cmd))) current = true; else dynamic = true;
    } else dynamic = true;
  });
  return { text: dynamic || current ? null : text, dynamic, glob, current, raw: segs };
}

const WRAPPERS = {
  env: { values: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'], assigns: true },
  command: { values: [] }, builtin: { values: [] }, exec: { values: ['-a'] }, nohup: { values: [] },
  time: { values: ['-f', '-o'] }, nice: { values: ['-n', '--adjustment'] }, ionice: { values: ['-c', '-n', '-p'] },
  sudo: { values: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group'] }, doas: { values: ['-u', '-C'] },
  timeout: { values: ['-s', '--signal', '-k', '--kill-after'], positional: 1 }, stdbuf: { values: ['-i', '-o', '-e'] },
  npx: { values: ['-p', '--package', '-c', '--call'] }, bunx: { values: ['-p', '--package'] }, coproc: { values: [] },
  xargs: { values: ['-I', '-i', '-n', '-P', '-d', '-s', '-L', '-l', '-E', '-e', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace'], xargs: true },
};
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'];
export const base = (p) => String(p || '').split('/').pop().toLowerCase();

// Analyse a command line in order: variables set earlier on the line, `cd`, wrappers (env, sudo, xargs, …), and
// commands inside sh -c, eval, $(…) and backticks. Returns the flat list of commands with their words evaluated:
// { name, argv: [word values], redirects, cwd (null when unknown), env, fromXargs, nested, text }.
// What echo or printf prints, when every argument is known: the script a shell reading the pipe would run.
function printed(cmd) {
  if (!cmd || !['echo', 'printf'].includes(cmd.name) || cmd.argv.some((a) => a.text === null)) return null;
  const a = cmd.argv.slice(1).map((w) => w.text);
  if (cmd.name === 'echo') {
    let escapes = false;
    while (/^-[neE]+$/.test(a[0] || '')) { if (a[0].includes('e')) escapes = true; a.shift(); }
    const text = a.join(' ');
    return escapes ? decodeEscapes(text) : text.replace(/\\n/g, '\n');
  }
  // printf decodes escapes in its format, and in arguments printed with %b.
  let i = 1;
  return decodeEscapes(a[0] || '').replace(/%%|%[sbdq]/g, (m) => (m === '%%' ? '%' : m === '%b' ? decodeEscapes(a[i++] ?? '') : a[i++] ?? ''));
}

export const MAX_DEPTH = 6;
export function analyse(src, { cwd, env, vars = new Map(), depth = 0, out = [], links = new Map() }) {
  // Deeper than this (sh -c inside sh -c …) isn't read: a marker makes the guard deny it as too deep to check.
  if (depth > MAX_DEPTH) { out.push({ name: '', argv: [], redirects: [], cwd, env: vars, tooDeep: true, nested: true, text: '' }); return out; }
  let prev = null;
  for (const c of parse(src)) {
    const local = new Map(vars);
    for (const a of c.assigns) {
      const v = evalWord(a.segs, vars, env);
      if (c.words.length) local.set(a.name, v.text); else vars.set(a.name, v.text);
    }
    // Commands inside substitutions run first, in the same folder.
    for (const segs of [...c.words, ...c.assigns.map((a) => a.segs), ...c.redirects.map((r) => r.target || [])]) {
      for (const s of segs) if (s.cmd !== undefined && !(segs.length === 1 && CURRENT_BRANCH.some((re) => re.test(s.cmd)))) analyse(s.cmd, { cwd, env, vars: new Map(vars), depth: depth + 1, out, links });
    }
    let argv = c.words.map((w) => evalWord(w, local, env));
    const redirects = c.redirects.map((r) => ({ op: r.op, fd: r.fd, target: r.target ? evalWord(r.target, local, env) : null, body: r.body ? r.body.body : null }));
    let fromXargs = false;
    // Unwrap env, sudo, xargs and friends to reach the real command.
    for (let guard = 0; guard < 8 && argv.length; guard++) {
      const lead = base(argv[0].text);
      // watch runs its words through sh -c (unless -x); script runs -c '<cmd>' (Linux) or the words after its log
      // file (macOS).
      if (lead === 'watch' || lead === 'script') {
        const values = lead === 'watch' ? ['-n', '--interval', '-q', '--equexit'] : ['-t', '-T', '-E', '-o', '-I', '-O', '-B'];
        const ci = lead === 'script' ? argv.findIndex((w) => w.text === '-c' || w.text === '--command') : -1;
        if (ci > 0) { if (argv[ci + 1]?.text != null) analyse(argv[ci + 1].text, { cwd, env, vars: new Map(local), depth: depth + 1, out, links }); argv = []; break; }
        let k = 1;
        while (k < argv.length && argv[k].text?.startsWith('-')) k += values.includes(argv[k].text) ? 2 : 1;
        if (lead === 'script') k++;
        const rest = argv.slice(k);
        if (lead === 'watch' && !argv.some((w) => w.text === '-x' || w.text === '--exec')) {
          if (rest.length && rest.every((w) => w.text !== null)) analyse(rest.map((w) => w.text).join(' '), { cwd, env, vars: new Map(local), depth: depth + 1, out, links });
          argv = []; break;
        }
        argv = rest; continue;
      }
      const w = WRAPPERS[lead];
      if (!w) break;
      if (w.xargs) fromXargs = true;
      let k = 1, skip = w.positional || 0;
      while (k < argv.length) {
        const t = argv[k].text;
        if (t === '--') { k++; break; }
        if (t && w.values.includes(t)) { k += 2; continue; }
        if (t && t.startsWith('-') && t.length > 1) { k++; continue; }
        // env NAME=value: part of the command's environment (git reads GIT_CONFIG_* from there).
        if (w.assigns && t && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { local.set(t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)); k++; continue; }
        if (w.assigns && t === null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[k].raw?.[0]?.lit || '')) { const r = argv[k].raw[0].lit; local.set(r.slice(0, r.indexOf('=')), null); k++; continue; }
        if (skip) { skip--; k++; continue; }
        break;
      }
      argv = argv.slice(k);
    }
    if (!argv.length && !redirects.length) { prev = null; continue; }
    const name = argv.length ? base(argv[0].text) : '';
    const text = argv.map((a) => (a.text === null ? '$?' : a.text)).join(' ');
    const cmd = { name, argv, redirects, cwd, env: local, fromXargs, nested: depth > 0, text, piped: !!c.piped, links: new Map(links) };
    const before = c.piped ? prev : null;
    prev = cmd;
    out.push(cmd);
    // cd changes the folder for the rest of the line; export sets variables.
    if (name === 'pushd') {
      const to = argv[1];
      cwd = !to || to.text === null ? null : to.text.startsWith('/') ? to.text : cwd ? `${cwd}/${to.text}` : null;
    } else if (name === 'popd') {
      cwd = null;
    } else if (name === 'cd') {
      const to = argv[1];
      cwd = !to ? env.HOME || null : to.text === null || to.text === '-' ? null : to.text.startsWith('/') ? to.text : cwd ? `${cwd}/${to.text}` : null;
    } else if (name === 'ln' && argv.slice(1).some((a) => a.text === '--symbolic' || (a.text && /^-[a-zA-Z]*s/.test(a.text) && !a.text.startsWith('--')))) {
      // A symlink made here is followed by later commands on the line (ln -s <target> <link>).
      const ps = positionals(argv, ['-t', '--target-directory', '-S', '--suffix']);
      if (ps.length >= 2 && ps[1].text !== null && cwd) {
        const link = resolvePath(cwd, ps[1].text.replace(/\/$/, ''));
        links.set(link, ps[0].text === null ? null : resolvePath(dirname(link), ps[0].text));
      }
    } else if (name === 'export') {
      for (const a of argv.slice(1)) { const m = a.text?.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) vars.set(m[1], m[2]); }
    } else if (SHELLS.includes(name)) {
      const i = argv.findIndex((a, k) => k > 0 && a.text && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text));
      const script = i > 0 ? argv[argv[i + 1]?.text === '--' ? i + 2 : i + 1] : null;
      if (script) { if (script.text !== null) analyse(script.text, { cwd, env, vars: new Map(local), depth: depth + 1, out, links }); else cmd.unknownScript = true; }
      // No -c and no script file: the shell runs what it reads. From a here-string, a here-document, or echo or
      // printf with known text, read that.
      else if (i < 0 && !positionals(argv, ['-o', '+o', '-O', '+O']).length) {
        const fed = c.redirects.find((r) => r.op === '<<<' || r.op === '<<');
        let text = fed ? (fed.op === '<<' ? fed.body.body : evalWord(fed.target || [], local, env).text) : printed(before);
        // An unquoted here-document's $VAR and ${VAR} are expanded first: known ones are filled in; an unknown one
        // means the script can't be known.
        if (fed?.op === '<<' && !fed.body.quoted && text !== null) {
          let unknown = false;
          text = text.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => { const v = local.has(a || b) ? local.get(a || b) : env[a || b]; if (v === undefined || v === null) unknown = true; return v ?? ''; });
          if (unknown) { cmd.unknownHereDoc = true; text = null; }
        }
        if (text !== null && text !== undefined) analyse(text, { cwd, env, vars: new Map(local), depth: depth + 1, out, links }); else cmd.unknownScript = true;
      }
    } else if (name === 'find') {
      // find … -exec <command> {} ; or +: the command runs on what find finds under its start point.
      const start = argv[1] && argv[1].text !== null && !/^[-(!]/.test(argv[1].text) ? argv[1].text : '.';
      for (let k = 1; k < argv.length; k++) {
        if (!['-exec', '-execdir', '-ok', '-okdir'].includes(argv[k].text)) continue;
        const words = [];
        for (k++; k < argv.length && ![';', '+'].includes(argv[k].text); k++) words.push(argv[k]);
        const line = words.map((w) => (w.text === '{}' ? `${shQuote(start.replace(/\/$/, ''))}/*` : w.text === null ? '"$UNKNOWN_FIND_ARG"' : shQuote(w.text))).join(' ');
        if (line) analyse(line, { cwd, env, vars: new Map(local), depth: depth + 1, out, links });
      }
    } else if (name === 'eval') {
      const parts = argv.slice(1);
      if (parts.every((a) => a.text !== null)) analyse(parts.map((a) => a.text).join(' '), { cwd, env, vars: new Map(local), depth: depth + 1, out, links }); else cmd.unknownScript = true;
    }
  }
  return out;
}

// The positional arguments of a command, skipping options (and the values of the options listed).
export function positionals(argv, valueOpts = []) {
  const out = [];
  let opts = true;
  for (let k = 1; k < argv.length; k++) {
    const t = argv[k].text;
    if (opts && t === '--') { opts = false; continue; }
    if (opts && t !== null && valueOpts.includes(t)) { k++; continue; }
    if (opts && t !== null && t.startsWith('-') && t.length > 1) continue;
    out.push(argv[k]);
  }
  return out;
}
const hasFlag = (argv, re) => argv.slice(1).some((a) => a.text && re.test(a.text));
export { hasFlag };

// Quote a word for a POSIX shell.
export const shQuote = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `'${String(v).replace(/'/g, "'\\''")}'`);
