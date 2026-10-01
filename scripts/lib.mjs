// Shared helpers for the repo scripts. No dependencies: plain Node 20+.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CORE_DIR = join(ROOT, 'core');        // every skill we author, any technology
export const UPSTREAM_DIR = join(ROOT, 'upstream'); // read-only mirror of official skills (generated)
export const STATUSES = ['draft', 'active', 'deprecated'];
export const APPLIES_TO = ['any', 'sfra', 'storefront-next', 'pwa-kit'];
export const REQUIRED_FIELDS = [
  'name', 'description', 'owner', 'version', 'status',
  'applies-to', 'agents-tested', 'last-reviewed',
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

// Our authored skills: one flat core/<name>.md per skill (or <overlay>/skills/<name>.md).
export function loadSkills(dir = CORE_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => {
      const path = join(dir, f);
      const text = readFileSync(path, 'utf8');
      const { data, body } = parseFrontmatter(text);
      return { file: f, path, rel: relative(ROOT, path), text, data, body };
    })
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

// Mirrored official skills: upstream/<source>/<name>/ folders, listed in upstream/manifest.json.
export function loadUpstreamSkills() {
  const p = join(UPSTREAM_DIR, 'manifest.json');
  if (!existsSync(p)) return [];
  const m = JSON.parse(readFileSync(p, 'utf8'));
  const out = [];
  for (const [source, src] of Object.entries(m.sources)) {
    for (const [set, names] of Object.entries(src.skills)) {
      for (const name of names) out.push({ source, set, name, dir: join(UPSTREAM_DIR, source, name), license: src.license, ref: src.ref });
    }
  }
  return out;
}

// A project overlay repo: overlay.json + skills/*.md. Returns null if the folder isn't an overlay.
export function loadOverlay(dir) {
  const p = join(dir, 'overlay.json');
  if (!existsSync(p)) return null;
  const config = JSON.parse(readFileSync(p, 'utf8'));
  return { dir, config, skills: loadSkills(join(dir, 'skills')) };
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
