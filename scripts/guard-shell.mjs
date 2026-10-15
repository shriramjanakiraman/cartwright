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

// Backslash escapes. Shells and versions read them differently: octal as \NNN (printf's format, $'…'), \0NNN
// (bash's echo -e) or either (zsh, dash); \xHH or not (dash); \uHHHH and \UHHHHHHHH, only \u (bash 3.2) or neither;
// \c as "stop here" (echo -e, %b), a control character ($'…') or not at all. A profile is one such reading.
const NAMED = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };
const profiles = (ctrl) => ['c', 'zero', 'both'].flatMap((octal) => [true, false].flatMap((hex) => ['all', 'u', 'none'].map((uni) => ({ octal, hex, uni, ctrl }))));
const ECHO_PROFILES = [{ raw: true }, ...profiles('stop')];
const FORMAT_PROFILES = profiles('none');
const ANSI_PROFILES = [{ octal: 'c', hex: true, uni: 'all', ctrl: 'cx' }, { octal: 'c', hex: true, uni: 'u', ctrl: 'cx' }, { octal: 'c', hex: true, uni: 'all', ctrl: 'drop' }];
const codePoint = (hex) => { const n = parseInt(hex, 16); if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error(`\\u${hex} isn't a character`); return String.fromCodePoint(n); };
// One escape at s[i] (a backslash) under a profile: [text, next index, stop?].
function escapeAt(s, i, p) {
  const rest = s.slice(i + 1);
  let m;
  if (p.raw || !rest) return ['\\', i + 1, false];
  if ((p.octal === 'zero' || p.octal === 'both') && (m = rest.match(/^0([0-7]{0,3})/))) return [String.fromCharCode(parseInt(m[1] || '0', 8) & 0xff), i + 1 + m[0].length, false];
  if ((p.octal === 'c' || p.octal === 'both') && (m = rest.match(/^[0-7]{1,3}/))) return [String.fromCharCode(parseInt(m[0], 8) & 0xff), i + 1 + m[0].length, false];
  if (p.hex && (m = rest.match(/^x([0-9A-Fa-f]{1,2})/))) return [String.fromCharCode(parseInt(m[1], 16)), i + 1 + m[0].length, false];
  if (p.uni !== 'none' && (m = rest.match(/^u([0-9A-Fa-f]{1,4})/))) return [codePoint(m[1]), i + 1 + m[0].length, false];
  if (p.uni === 'all' && (m = rest.match(/^U([0-9A-Fa-f]{1,8})/))) return [codePoint(m[1]), i + 1 + m[0].length, false];
  if (rest[0] === 'c') {
    if (p.ctrl === 'stop') return ['', s.length, true];
    if (p.ctrl === 'cx' && rest.length > 1) return [String.fromCharCode(rest.charCodeAt(1) & 0x1f), i + 3, false];
    if (p.ctrl === 'drop') return ['c', i + 2, false];
  }
  return [NAMED[rest[0]] ?? `\\${rest[0]}`, i + 2, false];
}
// A whole string under one profile: { text, stop } (stop: a \c ended the output there).
function decodeWith(s, p) {
  let text = '';
  for (let i = 0; i < s.length;) {
    if (s[i] !== '\\') { text += s[i++]; continue; }
    const [t, next, stop] = escapeAt(s, i, p);
    text += t; i = next;
    if (stop) return { text, stop: true };
  }
  return { text, stop: false };
}
// Escapes as bash 5's $'…', echo -e and printf %b read them (kept for callers that want one reading).
export const decodeEscapes = (s) => decodeWith(String(s), { octal: 'both', hex: true, uni: 'all', ctrl: 'none' }).text;
// $'…': one value when every shell reads it the same, otherwise null (it can't be known which one runs).
function ansiC(body) {
  const seen = new Set();
  for (const p of ANSI_PROFILES) { try { seen.add(decodeWith(body, p).text); } catch { return null; } }
  return seen.size === 1 ? [...seen][0] : null;
}

// One $… expansion starting at src[i]: a segment and the index after it.
function dollar(src, i) {
  const n = src[i + 1];
  // $'…' (ANSI-C quoting): a literal with backslash escapes decoded.
  if (n === "'") {
    let j = i + 2;
    while (j < src.length && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
    const lit = ansiC(src.slice(i + 2, j));
    return [lit === null ? { dyn: 'ansi-c' } : { lit, q: true }, Math.min(j + 1, src.length)];
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
// A variable set from a $'…' that shells read differently: its name, marked in the same map.
export const UNCERTAIN = (name) => `\0uncertain:${name}`;
export function evalWord(segs, vars, env) {
  let text = '', dynamic = false, glob = false, current = false, uncertain = false;
  segs.forEach((s, idx) => {
    if (s.lit !== undefined) {
      let t = s.lit;
      if (idx === 0 && !s.q && /^~(\/|$)/.test(t)) t = (env.HOME || '~') + t.slice(1);
      else if (idx === 0 && !s.q && /^~[^/]/.test(t)) dynamic = true;
      if (!s.q && /[*?[]/.test(t)) glob = true;
      text += t;
    } else if (s.v !== undefined) {
      const val = vars.has(s.v) ? vars.get(s.v) : env[s.v];
      if (vars.get(UNCERTAIN(s.v))) uncertain = true;
      if (val === undefined || val === null) dynamic = true; else text += val;
    } else if (s.cmd !== undefined) {
      if (segs.length === 1 && CURRENT_BRANCH.some((re) => re.test(s.cmd))) current = true; else dynamic = true;
    } else { dynamic = true; if (s.dyn === 'ansi-c') uncertain = true; }
  });
  return { text: dynamic || current ? null : text, dynamic, glob, current, uncertain, raw: segs };
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
// printf as bash runs it, for known arguments: escapes in the format, %s %b %c %d %i %u %x %X %o %% with flags, width
// and precision (also *), the format reused until the arguments run out. fp reads the format's escapes, bp %b's.
// Throws when the output can't be worked out exactly.
const MAX_PRINTED = 100000;
function renderPrintf(fmt, args, fp, bp) {
  let out = '', k = 0, stop = false;
  const next = () => (k < args.length ? args[k++] : undefined);
  const int = (v) => {
    if (v === undefined || v === '') return 0;
    const t = v.trim();
    if (/^[+-]?\d+$/.test(t) && !/^[+-]?0\d/.test(t)) return Number(t);
    if (/^[+-]?0[0-7]*$/.test(t)) return parseInt(t, 8);
    if (/^[+-]?0[xX][0-9a-fA-F]+$/.test(t)) return (t[0] === '-' ? -1 : 1) * parseInt(t.replace(/^[+-]/, ''), 16);
    if (/^['"]/.test(t) && t.length > 1) return t.codePointAt(1);
    throw new Error(`printf: ${v} isn't a number`);
  };
  const pad = (body, flags, width) => {
    if (!width || body.length >= width) return body;
    if (flags.includes('-')) return body + ' '.repeat(width - body.length);
    return ' '.repeat(width - body.length) + body;
  };
  for (let pass = 0; ; pass++) {
    const before = k;
    for (let i = 0; i < fmt.length && !stop;) {
      const ch = fmt[i];
      if (ch === '\\') { const [t, n] = escapeAt(fmt, i, fp); out += t; i = n; continue; }
      if (ch !== '%') { out += ch; i++; continue; }
      const m = fmt.slice(i).match(/^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([a-zA-Z%])/);
      if (!m) throw new Error('printf: a % the analyser can\'t read');
      i += m[0].length;
      const [, flags, w, pr, conv] = m;
      if (conv === '%') { out += '%'; continue; }
      const width = w === '*' ? int(next()) : w ? Number(w) : 0;
      const prec = pr === undefined ? null : pr === '*' ? int(next()) : Number(pr || 0);
      if (width < 0 || (prec !== null && prec < 0)) throw new Error('printf: a negative width or precision');
      if (conv === 's' || conv === 'b' || conv === 'c') {
        if (flags.replace('-', '')) throw new Error(`printf: flags ${flags} on %${conv}`);
        let v = next() ?? '';
        if (conv === 'b') { const d = decodeWith(v, bp); v = d.text; stop = d.stop; }
        if (conv === 'c') v = [...v][0] ?? '';
        if (prec !== null && conv !== 'c') v = v.slice(0, prec);
        out += pad(v, flags, width);
      } else if ('diuxXo'.includes(conv)) {
        if (flags.includes('#')) throw new Error('printf: the # flag');
        const n = int(next());
        if (!Number.isSafeInteger(n) || ('uxXo'.includes(conv) && n < 0)) throw new Error('printf: a number out of range');
        let digits = Math.abs(n).toString(conv === 'o' ? 8 : conv === 'x' || conv === 'X' ? 16 : 10);
        if (conv === 'X') digits = digits.toUpperCase();
        if (prec !== null) digits = prec === 0 && n === 0 ? '' : digits.padStart(prec, '0');
        const sign = n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        const zero = flags.includes('0') && !flags.includes('-') && prec === null;
        out += zero && width > sign.length + digits.length ? sign + digits.padStart(width - sign.length, '0') : pad(sign + digits, flags, width);
      } else throw new Error(`printf: %${conv} isn't rendered by the analyser`);
      if (out.length > MAX_PRINTED) throw new Error('printf: too much output');
    }
    if (stop || k >= args.length || k === before) break;
  }
  return out;
}

// What echo or printf prints into a pipe, when every argument is known: every way a shell could print it
// ({ texts }), { unrenderable: reason } when it can't be worked out exactly, or null when it isn't known text.
function printed(cmd) {
  if (!cmd || !['echo', 'printf'].includes(cmd.name)) return null;
  if (cmd.argv.some((a) => a.uncertain)) return { unrenderable: "a $'…' that shells read differently" };
  if (cmd.argv.some((a) => a.text === null)) return null;
  const a = cmd.argv.slice(1).map((w) => w.text);
  const texts = new Set();
  try {
    if (cmd.name === 'echo') {
      // Options or not, some shell decodes escapes (sh, zsh and dash do by default), so every reading counts.
      while (/^-[neE]+$/.test(a[0] || '')) a.shift();
      const text = a.join(' ');
      for (const p of ECHO_PROFILES) texts.add(decodeWith(text, p).text);
    } else {
      if (a[0] === '-v') return { texts: [''] };
      if (a[0] === '--') a.shift();
      if (!a.length) return { unrenderable: 'printf with no format' };
      const usesB = /%[-+ #0]*(\*|\d+)?(\.(\*|\d*))?b/.test(a[0]);
      for (const fp of FORMAT_PROFILES) for (const bp of usesB ? ECHO_PROFILES : [ECHO_PROFILES[1]]) texts.add(renderPrintf(a[0], a.slice(1), fp, bp));
    }
  } catch (e) { return { unrenderable: e.message }; }
  return { texts: [...texts] };
}

// Interpreters whose script text the guard reads for writes to guardrail (and generated) files: the text given with
// -c/-e/-p/-r/--eval, a here-document or here-string, a literal echo/printf pipe, or a script file. For a file it gives
// the text written by a here-document earlier on the line, or else the file's path for the rules to read.
const INTERPRETER = /^(python(\d+(\.\d+)*)?|node|nodejs|deno|bun|ruby|perl|php)$/;
const LANG = (n) => (/^python/.test(n) ? 'python' : n === 'nodejs' ? 'node' : n);
const CODE_OPTS = { python: ['-c'], node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], deno: [] };
const VALUE_OPTS = { python: ['-W', '-X'], node: ['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--input-type', '--env-file'], ruby: ['-I', '-r', '-C'], perl: ['-I', '-M', '-m'], php: ['-d', '-c', '-z'], bun: ['--cwd', '-r', '--preload'], deno: [] };
function interpreterScript(cmd, c, before, local, env, cwd, written) {
  const lang = LANG(cmd.name), a = cmd.argv;
  const texts = [];
  let file = null, code = false, module = false, stdin = false, k = 1;
  // deno eval <code> / deno run <file>; bun run <file> / bun <file>.
  if (lang === 'deno' || lang === 'bun') {
    const sub = a[1]?.text;
    if (lang === 'deno' && sub === 'eval') { const ps = positionals(a.slice(1), ['--ext']); if (ps[0]?.text != null) texts.push(ps[0].text); return { lang, texts, file: null, fileText: null }; }
    if (sub === 'run') k = 2; else if (lang === 'deno') return { lang, texts, file: null, fileText: null };
  }
  for (; k < a.length; k++) {
    const t = a[k].text;
    if (t === null) break;
    if (CODE_OPTS[lang].includes(t) || ((lang === 'perl' || lang === 'ruby') && /^-[a-zA-Z]*[eE]$/.test(t))) { if (a[k + 1]?.text != null) texts.push(a[k + 1].text); code = true; k++; continue; }
    const joined = CODE_OPTS[lang].find((o) => o.length === 2 && t.startsWith(o) && t.length > 2);
    if (joined) { texts.push(t.slice(2)); code = true; continue; }
    if (lang === 'python' && t === '-m') { module = true; break; }
    if (VALUE_OPTS[lang].includes(t)) { k++; continue; }
    if (t === '-') { stdin = true; break; }
    if (t.startsWith('-') && t.length > 1) continue;
    if (!code) file = t;
    break;
  }
  if (!code && !file && !module) stdin = true;
  if (stdin) {
    const fed = c.redirects.find((r) => r.op === '<<' || r.op === '<<<');
    if (fed) {
      let t = fed.op === '<<' ? fed.body.body : evalWord(fed.target || [], local, env).text;
      // An unquoted here-document's known $VAR and ${VAR} are filled in; unknown ones stay as written.
      if (fed.op === '<<' && !fed.body.quoted && t) t = t.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, x, y) => { const v = local.has(x || y) ? local.get(x || y) : env[x || y]; return typeof v === 'string' ? v : m; });
      if (t !== null && t !== undefined) texts.push(t);
    } else { const pr = printed(before); if (pr?.texts) texts.push(...pr.texts); }
  }
  let fileText = null, path = null;
  if (file && cwd) { const abs = resolvePath(cwd, file); if (written.has(abs)) fileText = written.get(abs); else path = abs; }
  return { lang, texts, file: path, fileText };
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
      const into = c.words.length ? local : vars;
      into.set(a.name, v.text);
      if (v.uncertain) into.set(UNCERTAIN(a.name), true); else into.delete(UNCERTAIN(a.name));
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
    // A file written here from a here-document (cat > fix.py <<EOF … EOF), for an interpreter later on the line.
    const written = (out.written ??= new Map());
    const doc = c.redirects.find((r) => r.op === '<<' && r.body);
    if (doc && cwd) {
      const targets = [...redirects.filter((r) => ['>', '>>', '>|'].includes(r.op) && r.target?.text).map((r) => r.target.text), ...(name === 'tee' ? positionals(argv, []).map((w) => w.text).filter(Boolean) : [])];
      for (const t of targets) written.set(resolvePath(cwd, t), doc.body.body);
    }
    if (INTERPRETER.test(name)) cmd.interp = interpreterScript(cmd, c, before, local, env, cwd, written);
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
      if (script) { if (script.text !== null) analyse(script.text, { cwd, env, vars: new Map(local), depth: depth + 1, out, links }); else { cmd.unknownScript = true; if (script.uncertain) cmd.unrenderable = "a $'…' that shells read differently"; } }
      // No -c and no script file: the shell runs what it reads. From a here-string, a here-document, or echo or
      // printf with known text, read that.
      else if (i < 0 && !positionals(argv, ['-o', '+o', '-O', '+O']).length) {
        const fed = c.redirects.find((r) => r.op === '<<<' || r.op === '<<');
        const fedWord = fed?.op === '<<<' ? evalWord(fed.target || [], local, env) : null;
        const pr = fed ? null : printed(before);
        if (fedWord?.uncertain) cmd.unrenderable = "a $'…' that shells read differently";
        if (pr?.unrenderable) cmd.unrenderable = pr.unrenderable;
        let text = fed ? (fed.op === '<<' ? fed.body.body : fedWord.text) : pr?.texts ? null : undefined;
        // An unquoted here-document's $VAR and ${VAR} are expanded first: known ones are filled in; an unknown one
        // means the script can't be known.
        if (fed?.op === '<<' && !fed.body.quoted && text !== null) {
          let unknown = false;
          text = text.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => { const v = local.has(a || b) ? local.get(a || b) : env[a || b]; if (v === undefined || v === null) unknown = true; return v ?? ''; });
          if (unknown) { cmd.unknownHereDoc = true; text = null; }
        }
        if (pr?.texts) for (const t of pr.texts) analyse(t, { cwd, env, vars: new Map(local), depth: depth + 1, out, links });
        else if (text !== null && text !== undefined) analyse(text, { cwd, env, vars: new Map(local), depth: depth + 1, out, links }); else cmd.unknownScript = true;
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
      if (parts.every((a) => a.text !== null)) analyse(parts.map((a) => a.text).join(' '), { cwd, env, vars: new Map(local), depth: depth + 1, out, links });
      else { cmd.unknownScript = true; if (parts.some((a) => a.uncertain)) cmd.unrenderable = "a $'…' that shells read differently"; }
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
