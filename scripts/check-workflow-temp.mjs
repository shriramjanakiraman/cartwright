#!/usr/bin/env node
// Offline guard for scratch files that would dirty a release/upstream checkout.
// Usage: node scripts/check-workflow-temp.mjs [workflow.yml ...]
// Deliberately checks simple shell writes, not arbitrary programs or shell variable assignments.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT, fail } from './lib.mjs';

const dirs = ['.github/workflows', 'templates/overlay/.github/workflows'];
const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => resolve(f))
  : dirs.flatMap((d) => readdirSync(join(ROOT, d)).filter((f) => /(?:release|upstream).*\.ya?ml$/.test(f)).sort().map((f) => join(ROOT, d, f)));
const errors = [];
const unquote = (s) => s?.replace(/^(['"])([\s\S]*)\1$/, '$2');
const safe = (s) => /^(?:\/|\$(?:RUNNER_TEMP|GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY)\b|\$\{(?:RUNNER_TEMP|GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY)\})/.test(s);

for (const file of files) {
  // Retain line numbers but drop YAML outside run blocks (including workflow comments).
  let indent = null;
  const shell = readFileSync(file, 'utf8').split(/\r?\n/).map((line) => {
    if (indent !== null && line.trim() && line.search(/\S/) <= indent) indent = null;
    const run = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (run) {
      if (/^[|>][-+]?\s*$/.test(run[2])) { indent = line.indexOf('run:'); return ''; }
      return unquote(run[2]);
    }
    return indent !== null ? line : '';
  }).join('\n');
  // Keep quoted arguments intact so prose such as echo "use > file" isn't treated as a write.
  const tokens = [...shell.matchAll(/#[^\n]*|(?:[^\s"'<>|;&()]+|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+|>>?|[|;&()]/g)]
    .filter((m) => !m[0].startsWith('#'));
  const check = (token) => {
    if (!token) return;
    const path = unquote(token[0]);
    if (safe(path)) return;
    const line = shell.slice(0, token.index).split('\n').length;
    errors.push(`${relative(ROOT, file)}:${line}: scratch output ${path} may dirty the checkout; use "$RUNNER_TEMP/<file>" instead`);
  };
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i][0];
    if (word === '>' || word === '>>') {
      if (tokens[i + 1]?.[0] !== '&') check(tokens[i + 1]); // >&2 duplicates a descriptor, not a file.
    } else if (word === '--report') {
      check(tokens[i + 1]);
    } else if (word === 'tee') {
      for (let j = i + 1; j < tokens.length; j++) {
        if (/^[|;&()<>]+$/.test(tokens[j][0]) || shell.slice(tokens[j - 1].index, tokens[j].index).includes('\n')) break;
        if (!tokens[j][0].startsWith('-')) check(tokens[j]);
      }
    }
  }
}

if (fail(errors, 'check-workflow-temp')) process.exit(1);
console.log(`check-workflow-temp: ${files.length} release/upstream workflow(s) OK`);
