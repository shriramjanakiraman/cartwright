#!/usr/bin/env node
// Data-leakage scan. Fails if anything client-specific, personal or secret is found.
//
// Usage:
//   node scripts/scrub-scan.mjs                         # scan the whole repo
//   node scripts/scrub-scan.mjs path/a.md path/b.md     # scan specific files (pre-commit)
//   node scripts/scrub-scan.mjs --denylist ../client-overlay/.scrub/denylist.txt
//   node scripts/scrub-scan.mjs --secrets-only          # overlay repos: client names allowed, secrets never
//
// A line can opt out of one finding with an inline marker:  <!-- scrub:allow -->
// Use it only for deliberate examples, and expect a reviewer to question it.
import { readFileSync, existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ROOT, walkTextFiles, fail } from './lib.mjs';

const args = process.argv.slice(2);
const denylists = [];
const files = [];
let secretsOnly = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--denylist') denylists.push(args[++i]);
  else if (args[i] === '--secrets-only') secretsOnly = true;
  else files.push(resolve(args[i]));
}
const defaultDeny = resolve(ROOT, '.scrub/denylist.local.txt'); // optional, git-ignored
if (existsSync(defaultDeny)) denylists.push(defaultDeny);

const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['hard-coded secret', /\b(api[_-]?key|client[_-]?secret|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][^"'<>{}$\s]{8,}["']/i],
];

const LEAK_RULES = [
  ['B2C instance host', /\b[a-z0-9-]+\.(dx\.)?commercecloud\.salesforce\.com\b/i],
  ['Demandware host', /\b[a-z0-9-]+\.demandware\.net\b/i],
  ['B2C org ID', /\bf_ecom_[a-z0-9]{4}_[a-z0-9]{2,4}\b/i],
  ['SCAPI short code', /short[_-]?code["']?\s*[:=]\s*["']?[a-z0-9]{8}\b/i],
  ['client/tenant ID (UUID)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['email address', /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b|users\.noreply\.github\.com\b|anthropic\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['Atlassian site', /\bhttps?:\/\/[a-z0-9-]+\.atlassian\.net\b/i],
  ['ticket key', /\b(?!PROJ-1234\b|ABC-123\b)[A-Z][A-Z0-9]{1,9}-\d{2,7}\b/],
  ['absolute user path', /(\/Users\/[^/\s`"')]+|\/home\/[^/\s`"')]+|[A-Z]:\\Users\\[^\\\s]+)/],
  ['IP address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/],
];

const deny = [];
for (const p of denylists) {
  if (!existsSync(p)) { console.error(`scrub-scan: denylist not found: ${p}`); process.exit(2); }
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const term = line.replace(/#.*/, '').trim();
    if (term) deny.push([`denylisted term "${term}"`, new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')]);
  }
}

const rules = secretsOnly ? SECRET_RULES : [...SECRET_RULES, ...LEAK_RULES, ...deny];
const SKIP = [/(^|\/)scripts\/scrub-scan\.mjs$/, /(^|\/)\.scrub\//, /(^|\/)upstream\.lock\.json$/, /(^|\/)package-lock\.json$/];
const targets = (files.length ? files : walkTextFiles()).filter((f) => !SKIP.some((r) => r.test(relative(ROOT, f))));

const findings = [];
for (const f of targets) {
  if (!existsSync(f)) continue;
  readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
    if (line.includes('scrub:allow')) return;
    for (const [label, re] of rules) {
      const m = line.match(re);
      if (m) findings.push(`${relative(ROOT, f)}:${i + 1}  ${label}  →  "${m[0].slice(0, 60)}"`);
    }
  });
}

if (fail(findings, 'scrub-scan')) {
  console.error('Replace each finding with a placeholder from CONTRIBUTING.md (e.g. <instance-host>, <client>, <ticket-key>).');
  process.exit(1);
}
console.log(`scrub-scan: ${targets.length} file(s) clean${deny.length ? `, ${deny.length} denylisted term(s) checked` : ''}${secretsOnly ? ' (secrets only)' : ''}`);
