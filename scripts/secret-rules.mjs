// What a secret looks like, in one place. Used by scrub-scan.mjs (this repo's leak check) and, shipped in the
// plugin as tools/secret-rules.mjs, by the project profiler, which hides any value that matches. No dependencies.

// Patterns for secret values in text: the scrub and the guard's commit check use these.
export const SECRET_RULES = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
  ['hard-coded secret', /\b(api[_-]?key|client[_-]?secret|secret|password|passwd|token)\b["']?\s*[:=]\s*["'][^"'<>{}$\s]{8,}["']/i],
  ['API key', /\b(sk_(live|test)_[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})/],
];

// More shapes, for values a tool copies out of a project (a package.json script, a pin). These are heuristics: too
// broad for the scrub and the guard, which would flag ordinary code, but right for copied values, where hiding a
// harmless one costs little and showing a real one costs a lot.
// A name counts as secret-looking when one of its parts (split on _ or -) ends in key, token, secret, pass, password,
// passwd, pwd or credential(s): API_KEY, GITHUB_TOKEN, DB_PASS and apiKey do; KEYCLOAK_URL doesn't.
const NAME = '(?:[A-Za-z0-9]+[_-])*[A-Za-z0-9]*(?:KEY|TOKEN|SECRET|PASS(?:WORD|WD)?|PWD|CREDENTIALS?)(?:[_-][A-Za-z0-9]+)*';
export const VALUE_SECRET_RULES = [
  ...SECRET_RULES,
  ['password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ['basic authorization', /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{8,}|\bBasic\s+(?=[A-Za-z0-9+/=]*[0-9+/=])[A-Za-z0-9+/=]{12,}/i],
  ['secret assignment', new RegExp(`(?:^|[\\s;&|("'])-{0,2}${NAME}=(?:"[^"\\s$]{6,}"|'[^'\\s]{6,}'|[^\\s"'$<{%][^\\s"';&|]{5,})`, 'i')],
  ['secret option', /(?:^|\s)--?(?:[A-Za-z0-9]+-)*(?:token|password|passwd|pass|secret|api-?key|access-key|secret-key|auth-token)\s+(?!-)[^\s$<{%]{6,}/i],
  ['database password option', /\b(mysql|mysqldump|mysqladmin)\b[^|;&]*\s-p[^\s-]\S*/],
  ['password option', /\b(docker\s+login|sshpass)\b[^|;&]*\s-p\s*(?!-)[^\s$]{4,}|\bredis-cli\b[^|;&]*\s-a\s+(?!-)[^\s$]{4,}/],
  ['user and password', /\bcurl\b[^|;&]*\s(?:-u|--user)\s*(?!-)[^\s:$]+:[^\s$]{4,}/],
  ['AWS secret key', /aws_secret_access_key\s*[=:]\s*["']?[A-Za-z0-9/+=]{20,}/i],
  ['webhook or DSN', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}|https?:\/\/[0-9a-f]{16,}(?::[0-9a-f]+)?@[^\s/]+/i],
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
