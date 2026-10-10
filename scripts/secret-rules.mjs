// What a secret looks like, in one place. Used by scrub-scan.mjs (this repo's leak check) and, shipped in the
// plugin as tools/secret-rules.mjs, by the project profiler, which hides any value that matches. No dependencies.

// Patterns for secret values in text.
export const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['hard-coded secret', /\b(api[_-]?key|client[_-]?secret|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][^"'<>{}$\s]{8,}["']/i],
];

// Files that hold credentials by convention. Tools that study a project never open them.
export const SECRET_FILES = [
  /^\.env($|\.)/, /^dw\.json$/, /\.pem$/, /\.key$/, /^id_rsa/, /\.p12$/, /\.pfx$/, /^\.npmrc$/, /^\.netrc$/, /^credentials/,
];

// The kind of secret a string looks like ('GitHub token', …), or null.
export const secretKind = (text) => (SECRET_RULES.find(([, re]) => re.test(String(text))) || [])[0] || null;
// Whether a path (any separator) names a credentials file.
export const isSecretPath = (path) => SECRET_FILES.some((re) => re.test(String(path).split(/[\\/]/).pop()));
// Shown instead of a value that looked like a secret.
export const HIDDEN = '<hidden: looked like a secret>';
