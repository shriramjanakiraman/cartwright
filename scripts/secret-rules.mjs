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

// More shapes, for values a tool copies out of a project (a package.json script, a pin): broader than the scrub
// needs, because hiding a harmless value there costs little and showing a real one costs a lot.
export const VALUE_SECRET_RULES = [
  ...SECRET_RULES,
  ['password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ['secret assignment', /\b[A-Za-z0-9_-]*(KEY|TOKEN|SECRET|PASS(WORD|WD)?)[A-Za-z0-9_]*=[^\s"'$<{%][^\s"']{5,}/i],
  ['database password option', /\b(mysql|mysqldump|mysqladmin)\b[^|;&]*\s-p[^\s-]\S*/],
  ['API key', /\b(sk_live_[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})/],
];

// Files that hold credentials by convention, as globs on the file name. Tools that study a project never open them.
export const SECRET_FILE_GLOBS = ['.env*', 'dw.json', '*.pem', '*.key', 'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*',
  '*.p12', '*.pfx', '*.jks', '*.keystore', '.npmrc', '.netrc', '.pgpass', 'credentials*', 'secrets.*', '*.tfvars'];
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
export const SECRET_FILES = SECRET_FILE_GLOBS.map(globRe);

// The kind of secret a string looks like ('GitHub token', …), or null. `rules` defaults to the broad value set.
export const secretKind = (text, rules = VALUE_SECRET_RULES) => (rules.find(([, re]) => re.test(String(text))) || [])[0] || null;
// Whether a path (any separator) names a credentials file.
export const isSecretPath = (path) => SECRET_FILES.some((re) => re.test(String(path).split(/[\\/]/).pop()));
// Shown instead of a value that looked like a secret.
export const HIDDEN = '<hidden: looked like a secret>';
