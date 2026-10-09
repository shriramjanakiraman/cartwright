// The overlay registry: lets client setup find an existing client's overlay from any name a developer
// types ("Acme Corporation", "AC", "acme-corporation") without the core repo containing any client name.
//
// Each name form is stretched with scrypt into a lookup id and an encryption key. An entry stores only the
// id and the details encrypted with AES-GCM and a 256-bit key (project code, client name, overlay repo,
// lead). Nothing is readable unless you already know a name for that client. Short aliases can still be guessed, so scrypt is
// deliberately slow to make guessing many names costly; it can't make "AC" secret.
//
// Shipped in the plugin with setup.mjs; registry.mjs (core repo only) adds entries. Plain Node 20+.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export const KDF = { name: 'scrypt', N: 2 ** 15, r: 8, p: 1, salt: 'agent-skills-overlay-registry-v1' };
const NOISE = new Set(['the', 'inc', 'incorporated', 'ltd', 'limited', 'llc', 'plc', 'corp', 'corporation', 'co', 'company', 'group', 'gmbh', 'ag', 'sa', 'bv', 'holdings']);

const words = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(Boolean);

// Every form of a name we match on, with its kind: the whole name and the name without company suffixes
// ("name"), and its initials ("initials").
export function forms(name) {
  const all = words(name);
  const core = all.filter((w) => !NOISE.has(w));
  const out = new Map();
  for (const v of [all.join(''), core.join('')]) out.set(v, 'name');
  if (core.length >= 2) { const i = core.map((w) => w[0]).join(''); if (!out.has(i)) out.set(i, 'initials'); }
  return [...out].filter(([v]) => v.length >= 2).map(([value, kind]) => ({ value, kind }));
}
export const variants = (name) => forms(name).map((f) => f.value);

function derive(value) {
  const buf = scryptSync(value, KDF.salt, 64, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
  return { id: buf.subarray(0, 16).toString('hex'), key: buf.subarray(32, 64) };
}

// Encrypted entries for one client: one per form of every alias. An alias given in full (even a short one
// like "AC") is a "name" form; initials worked out from a longer name are "initials" forms.
export function makeEntries(details, aliases) {
  const all = new Map();
  for (const f of aliases.flatMap(forms)) if (all.get(f.value) !== 'name') all.set(f.value, f.kind);
  return [...all].map(([value, kind]) => {
    const { id, key } = derive(value);
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify({ ...details, kind }), 'utf8'), c.final(), c.getAuthTag()]);
    return { id, iv: iv.toString('hex'), data: data.toString('hex') };
  });
}

// The clients a typed name matches: [{ code, client, overlay, lead, match }], one per project. "strong":
// the typed name equals a registered name or alias. "possible": they only share initials; returned only
// when nothing matches strongly, so "Acme Corporation" never also brings back another "AC" client.
export function lookup(registry, name) {
  const found = new Map();
  for (const f of forms(name)) {
    const { id, key } = derive(f.value);
    for (const e of (registry.entries || []).filter((x) => x.id === id)) {
      try {
        const raw = Buffer.from(e.data, 'hex');
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'hex'));
        d.setAuthTag(raw.subarray(raw.length - 16));
        const { kind, ...details } = JSON.parse(Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8'));
        const match = f.kind === 'name' && kind === 'name' ? 'strong' : 'possible';
        if (found.get(details.code)?.match !== 'strong') found.set(details.code, { ...details, match });
      } catch { /* not ours, or tampered */ }
    }
  }
  const all = [...found.values()];
  return all.some((d) => d.match === 'strong') ? all.filter((d) => d.match === 'strong') : all;
}

export const emptyRegistry = () => ({ version: 1, kdf: KDF, entries: [] });
