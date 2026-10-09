#!/usr/bin/env node
// Register a client's overlay so client setup can find it from any name a developer types, without the
// core repo containing the client's name (see registry-core.mjs and documentation/12-client-setup.md).
//
// Usage (core repo):
//   node scripts/registry.mjs add --from-overlay ../<code>-agent-skills     # reads overlay.json
//   node scripts/registry.mjs add --code prja --client "Client Name" --alias CN --repo <owner/repo or git URL> --lead @handle
//   node scripts/registry.mjs lookup "<name>"     # what setup would find
//   node scripts/registry.mjs --check             # CI: the registry file is well formed
// Then commit registry/overlays.json and open a pull request into develop like any other change.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT } from './lib.mjs';
import { emptyRegistry, lookup, makeEntries, KDF } from './registry-core.mjs';

export const REGISTRY = join(ROOT, 'registry', 'overlays.json');
const args = process.argv.slice(2);
const all = (f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []));
const one = (f) => all(f)[0];
const fail = (m) => { console.error(`registry: ${m}`); process.exit(1); };
const load = () => (existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf8')) : emptyRegistry());

if (args.includes('--check')) {
  const r = load();
  const bad = [];
  if (r.version !== 1) bad.push('version must be 1');
  if (JSON.stringify(r.kdf) !== JSON.stringify(KDF)) bad.push('kdf settings changed; existing entries would no longer be found');
  for (const [i, e] of (r.entries || []).entries()) {
    if (!/^[0-9a-f]{32}$/.test(e.id || '') || !/^[0-9a-f]{24}$/.test(e.iv || '') || !/^[0-9a-f]{34,}$/.test(e.data || '')) bad.push(`entry ${i} is malformed`);
    if (Object.keys(e).some((k) => !['id', 'iv', 'data'].includes(k))) bad.push(`entry ${i} has fields other than id, iv, data (nothing readable may be stored)`);
  }
  if (bad.length) fail(bad.join('; '));
  console.log(`registry --check: ${(r.entries || []).length} entr${(r.entries || []).length === 1 ? 'y' : 'ies'}, well formed`);
  process.exit(0);
}

const [cmd] = args;
if (cmd === 'lookup') {
  const name = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
  if (!name) fail('give a name to look up');
  const found = lookup(load(), name);
  console.log(found.length ? JSON.stringify(found, null, 2) : `No registered client matches "${name}".`);
  process.exit(found.length ? 0 : 1);
}
if (cmd !== 'add') fail('usage: registry.mjs add … | lookup "<name>" | --check');

let details, aliases;
if (one('--from-overlay')) {
  const dir = resolve(one('--from-overlay'));
  const p = join(dir, 'overlay.json');
  if (!existsSync(p)) fail(`no overlay.json in ${dir}`);
  const o = JSON.parse(readFileSync(p, 'utf8'));
  details = { code: o.project, client: o.client, overlay: o.repo, lead: o.lead || o.owner };
  aliases = [o.client, ...(o.aliases || [])];
} else {
  details = { code: one('--code'), client: one('--client'), overlay: one('--repo'), lead: one('--lead') };
  aliases = [one('--client'), ...all('--alias')];
}
aliases = aliases.filter(Boolean);
if (!/^[a-z][a-z0-9]{1,15}$/.test(details.code || '')) fail('a project code like "prja" is required');
if (!details.client || /<.*>/.test(details.client)) fail('the client\'s name is required (overlay.json "client" or --client)');
if (!details.overlay || /<.*>/.test(details.overlay)) fail('the overlay repo is required (overlay.json "repo" or --repo): owner/repo or a git URL on any host');
if (!details.lead || /<.*>/.test(details.lead)) fail('a lead to ask for access is required (overlay.json "lead" or --lead)');

const r = load();
const fresh = makeEntries(details, aliases);
// Re-registering replaces this project's entries for the same names; another client that happens to
// share a name form (two clients both "MK") keeps its own entry, and setup shows both.
const freshIds = new Set(fresh.map((e) => e.id));
const ours = (e) => freshIds.has(e.id) && aliases.some((a) => lookup({ entries: [e] }, a).some((d) => d.code === details.code));
r.entries = [...r.entries.filter((e) => !ours(e)), ...fresh];
mkdirSync(dirname(REGISTRY), { recursive: true });
writeFileSync(REGISTRY, JSON.stringify(r, null, 2) + '\n');
console.log(`registry: ${details.code} registered under ${fresh.length} name form(s). Check with: node scripts/registry.mjs lookup "${aliases[0]}"`);
