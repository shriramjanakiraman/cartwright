// Python: pyproject.toml (read with a minimal TOML reader), uv / poetry / pipenv / pip, the Python pin, pytest and
// ruff configuration, and Makefile targets (names only).
import { toolVersion } from './node.mjs';

const LOCKFILES = [['uv.lock', 'uv'], ['poetry.lock', 'poetry'], ['Pipfile.lock', 'pipenv'], ['pdm.lock', 'pdm']];
const KNOWN = ['django', 'flask', 'fastapi', 'starlette', 'pydantic', 'sqlalchemy', 'celery', 'httpx', 'requests', 'numpy', 'pandas',
  'pytest', 'ruff', 'black', 'mypy', 'b2c-tooling-sdk'];
const RUNNER = { uv: 'uv run ', poetry: 'poetry run ', pipenv: 'pipenv run ', pdm: 'pdm run ' };

// --- a minimal TOML reader: tables, arrays of tables, dotted keys, strings, numbers, booleans, arrays and inline
// tables. Enough for pyproject.toml; anything it doesn't understand is kept as its raw text.
function scan(text, stopAt) {
  // Index of the first stopAt character outside strings and brackets (or -1).
  let depth = 0, q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (depth === 0 && stopAt.includes(c)) return i;
  }
  return -1;
}
const uncomment = (line) => { const i = scan(line, '#'); return i < 0 ? line : line.slice(0, i); };
const splitTop = (s, sep) => { const out = []; let rest = s; for (;;) { const i = scan(rest, sep); if (i < 0) { out.push(rest); return out; } out.push(rest.slice(0, i)); rest = rest.slice(i + 1); } };
const keyPath = (k) => splitTop(k.trim(), '.').map((p) => p.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2'));
const balanced = (s) => { let d = 0, q = null; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '[' || c === '{') d++; else if (c === ']' || c === '}') d--; } return d <= 0; };

function value(raw) {
  const v = raw.trim();
  if (v.startsWith('"""') || v.startsWith("'''")) return v.slice(3, v.lastIndexOf(v.slice(0, 3))).replace(/^\r?\n/, '');
  if (v.startsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(v)) return Number(v.replace(/_/g, ''));
  if (v.startsWith('[')) return splitTop(v.slice(1, v.lastIndexOf(']')), ',').map((x) => uncomment(x)).filter((x) => x.trim()).map(value);
  if (v.startsWith('{')) {
    const o = {};
    for (const pair of splitTop(v.slice(1, v.lastIndexOf('}')), ',')) {
      const i = scan(pair, '=');
      if (i > 0) setPath(o, keyPath(pair.slice(0, i)), value(pair.slice(i + 1)));
    }
    return o;
  }
  return v;
}
function setPath(obj, keys, v) {
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? o[k] : (o[k] = {});
  o[keys.at(-1)] = v;
}
function table(root, keys) {
  let o = root;
  for (const k of keys) {
    if (Array.isArray(o[k])) o = o[k].at(-1);
    else o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  }
  return o;
}

export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = uncomment(lines[i]).trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^\[\[(.+)\]\]$/))) {
      const keys = keyPath(m[1]);
      const parent = table(root, keys.slice(0, -1));
      const k = keys.at(-1);
      if (!Array.isArray(parent[k])) parent[k] = [];
      parent[k].push(cur = {});
      continue;
    }
    if ((m = line.match(/^\[(.+)\]$/))) { cur = table(root, keyPath(m[1])); continue; }
    const eq = scan(line, '=');
    if (eq <= 0) continue;
    let raw = line.slice(eq + 1).trim();
    const fence = raw.startsWith('"""') ? '"""' : raw.startsWith("'''") ? "'''" : null;
    if (fence) while (raw.indexOf(fence, 3) < 0 && i + 1 < lines.length) raw += '\n' + lines[++i];
    else while (!balanced(raw) && i + 1 < lines.length) raw += '\n' + uncomment(lines[++i]);
    setPath(cur, keyPath(line.slice(0, eq)), value(raw));
  }
  return root;
}

// "fastapi>=0.110" → ['fastapi', '>=0.110'] (PEP 508, without extras and markers).
const requirement = (s) => { const m = String(s).match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*([^;]*)/); return m ? [m[1].toLowerCase(), m[2].trim()] : null; };

export default {
  id: 'python',
  detect(ctx) {
    const marker = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'].find((f) => ctx.exists(f));
    if (!marker) return null;
    const py = (marker === 'pyproject.toml' && ctx.toml('pyproject.toml')) || {};
    const tool = py.tool || {};
    const r = { languages: [{ value: 'Python', source: marker }], frameworks: [], commands: {}, layout: {} };

    const pin = (ctx.text('.python-version') || '').trim();
    if (pin) r.python = { value: pin, source: '.python-version' };
    else if (toolVersion(ctx, ['python'])) r.python = { value: toolVersion(ctx, ['python']), source: '.tool-versions' };
    else if (typeof py.project?.['requires-python'] === 'string') r.python = { value: py.project['requires-python'], source: 'pyproject.toml#project.requires-python' };

    const lock = LOCKFILES.find(([f]) => ctx.exists(f));
    if (lock) r.packageManager = { value: lock[1], source: lock[0] };
    else if (tool.poetry) r.packageManager = { value: 'poetry', source: 'pyproject.toml#tool.poetry' };
    else if (tool.uv) r.packageManager = { value: 'uv', source: 'pyproject.toml#tool.uv' };
    else if (ctx.exists('requirements.txt')) r.packageManager = { value: 'pip', source: 'requirements.txt' };
    const runner = RUNNER[r.packageManager?.value] || '';

    // The project's own commands first (Makefile targets), then commands its tool configuration implies.
    const targets = new Set();
    for (const line of (ctx.text('Makefile') || '').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/);
      if (m) targets.add(m[1]);
    }
    for (const name of ['build', 'test', 'lint']) if (targets.has(name)) r.commands[name] = { run: `make ${name}`, how: 'defined', source: `Makefile#${name}` };
    const other = [...targets].filter((t) => !['build', 'test', 'lint'].includes(t)).sort();
    if (other.length) r.otherScripts = { value: other, source: 'Makefile' };

    const groups = [['project.dependencies', py.project?.dependencies]];
    for (const [g, list] of Object.entries(py.project?.['optional-dependencies'] || {})) groups.push([`project.optional-dependencies.${g}`, list]);
    for (const [g, list] of Object.entries(py['dependency-groups'] || {})) groups.push([`dependency-groups.${g}`, list]);
    for (const [where, list] of groups) {
      for (const req of Array.isArray(list) ? list : []) {
        const p = requirement(req);
        if (p && KNOWN.includes(p[0]) && !r.frameworks.some((f) => f.name === p[0])) r.frameworks.push({ name: p[0], version: p[1] || 'any', source: `pyproject.toml#${where}` });
      }
    }
    for (const [name, spec] of Object.entries(tool.poetry?.dependencies || {})) {
      const n = name.toLowerCase();
      if (KNOWN.includes(n) && !r.frameworks.some((f) => f.name === n)) r.frameworks.push({ name: n, version: typeof spec === 'string' ? spec : spec?.version || 'any', source: 'pyproject.toml#tool.poetry.dependencies' });
    }

    if (!r.commands.test) {
      const pytest = tool.pytest?.ini_options ? 'pyproject.toml#tool.pytest.ini_options' : ctx.exists('pytest.ini') ? 'pytest.ini'
        : r.frameworks.find((f) => f.name === 'pytest')?.source;
      if (pytest) r.commands.test = { run: `${runner}pytest`, how: 'configured', source: pytest };
    }
    if (!r.commands.lint) {
      const ruff = tool.ruff ? 'pyproject.toml#tool.ruff' : ['ruff.toml', '.ruff.toml'].find((f) => ctx.exists(f));
      if (ruff) r.commands.lint = { run: `${runner}ruff check .`, how: 'configured', source: ruff };
    }

    // Packages: src/<name>/__init__.py (src layout), else top-level <name>/__init__.py.
    const pkgs = ctx.list('src', { depth: 1 }).filter((d) => d.endsWith('/') && ctx.exists(`${d}__init__.py`)).map((d) => d.slice(4, -1));
    if (pkgs.length) r.layout.packages = { value: pkgs, source: 'src/' };
    else {
      const flat = ctx.list('.', { depth: 1 }).filter((d) => d.endsWith('/') && !/^(tests?|docs?)\/$/.test(d) && ctx.exists(`${d}__init__.py`)).map((d) => d.slice(0, -1));
      if (flat.length) r.layout.packages = { value: flat, source: flat.map((d) => `${d}/`).join(', ') };
    }
    return r;
  },
};
