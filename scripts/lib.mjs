// Shared helpers for the repo scripts. No dependencies: plain Node 20+.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = join(ROOT, 'skills');
export const SCOPES = ['common', 'sfcc'];
export const STATUSES = ['draft', 'active', 'deprecated'];
export const APPLIES_TO = ['any', 'sfra', 'storefront-next', 'pwa-kit'];
export const REQUIRED_FIELDS = [
  'name', 'description', 'owner', 'version', 'status',
  'scope', 'applies-to', 'agents-tested', 'last-reviewed',
];
export const REQUIRED_SECTIONS = ['When to use', 'Constraints', 'References'];

// Minimal YAML-subset parser for skill frontmatter:
// scalars, quoted strings, `|`/`>` block scalars, `- item` lists and `[a, b]` lists.
export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: null, body: text };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv;
    let val = raw.trim();
    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      val = block.join(val.startsWith('|') ? '\n' : ' ').trim();
    } else if (val === '') {
      const list = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) list.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
      val = list.length ? list : '';
    } else if (/^\[.*\]$/.test(val)) {
      val = val.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    } else {
      val = unquote(val);
    }
    data[key] = val;
  }
  return { data, body: text.slice(m[0].length) };
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

export const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function loadSkills() {
  const skills = [];
  for (const scope of readdirSync(SKILLS_DIR)) {
    const dir = join(SKILLS_DIR, scope);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const path = join(dir, f);
      const text = readFileSync(path, 'utf8');
      const { data, body } = parseFrontmatter(text);
      skills.push({ scope, file: f, path, rel: relative(ROOT, path), text, data, body });
    }
  }
  return skills.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function loadLock() {
  const p = join(ROOT, 'upstream.lock.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { sources: {} };
}

// Every skill name published upstream, for shadowing and depends-on checks.
export function upstreamSkillNames(lock = loadLock()) {
  const names = new Set();
  for (const src of Object.values(lock.sources || {})) {
    for (const list of Object.values(src.skills || {})) list.forEach((n) => names.add(n));
    (src.provides || []).forEach((n) => names.add(n));
  }
  return names;
}

// Text files tracked for scanning (skips .git, node_modules, binaries).
export function walkTextFiles(dir = ROOT, out = []) {
  for (const f of readdirSync(dir)) {
    if (['.git', 'node_modules'].includes(f)) continue;
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) walkTextFiles(p, out);
    else if (/\.(md|json|ya?ml|mjs|js|ts|sh|txt)$|^CODEOWNERS$|^pre-commit$/.test(basename(p))) out.push(p);
  }
  return out;
}

export function fail(msgs, label) {
  if (!msgs.length) return false;
  console.error(`\n${label}: ${msgs.length} problem(s)\n`);
  for (const m of msgs) console.error(`  ✗ ${m}`);
  console.error('');
  return true;
}
