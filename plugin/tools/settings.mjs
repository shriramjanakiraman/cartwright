// Cartwright guardrail settings: the team's file (committed, changed through pull requests) and each developer's
// personal file (never committed, can only add or tighten). Validation, the merge rules and the fail-safe when
// the team's file is broken all live here, so the profiler, the session-start hook and the guard agree.
// Shipped in the plugin as tools/settings.mjs. No dependencies.

export const SETTINGS_VERSION = 1;
export const PERSONAL_VERSION = 1;
// The four must-never rules. Each can be switched off only in the team's settings.
export const GUARDRAILS = ['protected-branches', 'secrets', 'generated-files', 'destructive-outside-project'];
// Protected when the settings don't list any branches, and always when the settings are broken.
export const DEFAULT_PROTECTED = ['main', 'develop'];
export const RULE_PATTERN_MAX = 300;
export const SETTINGS_COMMENT = "Cartwright guardrail settings. Change them in a pull request; an agent needs the person's approval to edit this file. See the Cartwright guide 'Project profile and guardrails'.";
export const TRACKS_COMMENT = 'Process tracks (quick, standard, full) have no effect yet; they arrive in a later Cartwright release.';
const KNOWN_KEYS = ['$comment', 'cartwright', 'version', 'guardrails', 'protectedBranches', 'generated', 'secrets', 'locations', 'rules', 'clientProject', 'tracks'];
const PERSONAL_KEYS = [...KNOWN_KEYS, 'preferences'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v, at, errors) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s.trim())) { errors.push(`${at}: must be a list of non-empty strings`); return []; }
  return v;
};

// Check one settings object (team or personal). Never quotes a value in a message, only the key path.
// Returns { ok, errors, warnings, value } where value has every key filled in with its default.
function check(data, kind) {
  const errors = [], warnings = [];
  if (!isObj(data)) return { ok: false, errors: ['the file must hold a JSON object'], warnings, value: null };
  const version = kind === 'settings' ? SETTINGS_VERSION : PERSONAL_VERSION;
  if (data.cartwright !== kind) errors.push(`cartwright: must be "${kind}"`);
  if (typeof data.version === 'number' && data.version > version) {
    return { ok: false, newer: true, errors: [`version ${data.version}: this ${kind} file needs a newer Cartwright; update the plugin`], warnings, value: null };
  }
  if (data.version !== version) errors.push(`version: must be ${version}`);
  for (const k of Object.keys(data)) if (!(kind === 'settings' ? KNOWN_KEYS : PERSONAL_KEYS).includes(k)) warnings.push(`${k}: not known to this Cartwright version and ignored; update Cartwright if it's newer`);

  const guardrails = {};
  if (data.guardrails !== undefined && !isObj(data.guardrails)) errors.push('guardrails: must be an object of rule: true|false');
  for (const [k, v] of Object.entries(isObj(data.guardrails) ? data.guardrails : {})) {
    if (!GUARDRAILS.includes(k)) { warnings.push(`guardrails.${k}: not a rule this Cartwright version knows; ignored`); continue; }
    if (typeof v !== 'boolean') errors.push(`guardrails.${k}: must be true or false`);
    else guardrails[k] = v;
  }
  const protectedBranches = strList(data.protectedBranches, 'protectedBranches', errors);
  const generated = [];
  if (data.generated !== undefined && !Array.isArray(data.generated)) errors.push('generated: must be a list of { "path": …, "regenerate": … }');
  (Array.isArray(data.generated) ? data.generated : []).forEach((g, i) => {
    if (!isObj(g) || typeof g.path !== 'string' || !g.path.trim()) errors.push(`generated[${i}].path: must be a non-empty path or glob`);
    else if (typeof g.regenerate !== 'string' || !g.regenerate.trim()) errors.push(`generated[${i}].regenerate: must name the command that regenerates it`);
    else generated.push({ path: g.path, regenerate: g.regenerate });
  });
  if (data.secrets !== undefined && !isObj(data.secrets)) errors.push('secrets: must be an object with "allow"');
  const secrets = { allow: strList(data.secrets?.allow, 'secrets.allow', errors) };
  if (data.locations !== undefined && !isObj(data.locations)) errors.push('locations: must be an object with "allowed" and "protected"');
  const locations = { allowed: strList(data.locations?.allowed, 'locations.allowed', errors), protected: strList(data.locations?.protected, 'locations.protected', errors) };
  const rules = [];
  if (data.rules !== undefined && !Array.isArray(data.rules)) errors.push('rules: must be a list');
  const ids = new Set();
  (Array.isArray(data.rules) ? data.rules : []).forEach((r, i) => {
    const at = `rules[${i}]`;
    if (!isObj(r)) { errors.push(`${at}: must be an object`); return; }
    if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(r.id)) { errors.push(`${at}.id: must be a short lowercase id (letters, digits, hyphens)`); return; }
    if (ids.has(r.id)) errors.push(`${at}.id: "${r.id}" is used twice`);
    ids.add(r.id);
    if (typeof r.message !== 'string' || !r.message.trim()) errors.push(`${at}.message: must say why it's blocked and what to do instead`);
    if (r.shell === undefined && r.paths === undefined) errors.push(`${at}: needs "shell" (a pattern) or "paths" (globs)`);
    if (r.shell !== undefined) {
      if (typeof r.shell !== 'string' || !r.shell || r.shell.length > RULE_PATTERN_MAX) errors.push(`${at}.shell: must be a pattern of at most ${RULE_PATTERN_MAX} characters`);
      else { try { new RegExp(r.shell); } catch { errors.push(`${at}.shell: isn't a valid regular expression`); } }
    }
    if (r.paths !== undefined) strList(r.paths, `${at}.paths`, errors);
    rules.push(r);
  });
  if (data.clientProject !== undefined && typeof data.clientProject !== 'boolean') errors.push('clientProject: must be true or false');
  if (data.tracks !== undefined && !isObj(data.tracks)) errors.push('tracks: must be an object');
  if (data.preferences !== undefined && !isObj(data.preferences)) errors.push('preferences: must be an object');

  const value = {
    guardrails, protectedBranches, generated, secrets, locations, rules,
    ...(typeof data.clientProject === 'boolean' ? { clientProject: data.clientProject } : {}),
    ...(isObj(data.tracks) ? { tracks: data.tracks } : {}),
    ...(isObj(data.preferences) ? { preferences: data.preferences } : {}),
    has: { protectedBranches: data.protectedBranches !== undefined, clientProject: data.clientProject !== undefined, tracks: data.tracks !== undefined, preferences: data.preferences !== undefined },
  };
  return { ok: errors.length === 0, errors, warnings, value: errors.length ? null : value };
}

export const validateSettings = (data) => check(data, 'settings');
export const validatePersonal = (data) => check(data, 'personal');

// The team's settings as they apply, with defaults: every rule on unless switched off, main and develop
// protected unless the team lists its own branches.
export function teamDefaults(v) {
  return {
    guardrails: Object.fromEntries(GUARDRAILS.map((g) => [g, v.guardrails[g] !== false])),
    protectedBranches: v.has.protectedBranches ? [...v.protectedBranches] : [...DEFAULT_PROTECTED],
    generated: v.generated.map((g) => ({ ...g })),
    secrets: { allow: [...v.secrets.allow] },
    locations: { allowed: [...v.locations.allowed], protected: [...v.locations.protected] },
    rules: v.rules.map((r) => ({ ...r })),
    ...(v.has.clientProject ? { clientProject: v.clientProject } : {}),
    preferences: {},
  };
}

const union = (a, b) => [...new Set([...a, ...b])];

// Merge a developer's personal file over the team's settings. The personal file can only add or tighten; the
// table below is the whole rule (later phases add rows). Returns { settings, loosening: [messages] }.
//   guardrails.<id>       OR: personal true switches a rule on for that person; false is ignored and reported
//   protectedBranches     union
//   generated             union; for the same path the team's regenerate command wins
//   locations.protected   union
//   locations.allowed     team only; personal entries are ignored and reported (allowing loosens a rule)
//   secrets.allow         team only; reported
//   rules                 union by id; a personal rule reusing a team rule's id is ignored and reported
//   tracks, clientProject team only in this version; reported
//   preferences           personal only
export function mergePersonal(team, personal) {
  const s = JSON.parse(JSON.stringify(team));
  const loosening = [];
  if (!personal) return { settings: s, loosening };
  for (const [g, on] of Object.entries(personal.guardrails || {})) {
    if (on === true) s.guardrails[g] = true;
    else if (on === false && s.guardrails[g]) loosening.push(`guardrails.${g}: the personal file tries to switch this rule off; the personal file can only add or tighten rules`);
  }
  s.protectedBranches = union(s.protectedBranches, personal.protectedBranches || []);
  for (const g of personal.generated || []) if (!s.generated.some((t) => t.path === g.path)) s.generated.push({ ...g });
  s.locations.protected = union(s.locations.protected, personal.locations?.protected || []);
  if (personal.locations?.allowed?.length) loosening.push('locations.allowed: allowing a location loosens a rule, so only the team settings can do it');
  if (personal.secrets?.allow?.length) loosening.push('secrets.allow: allowing secrets in a path loosens a rule, so only the team settings can do it');
  for (const r of personal.rules || []) {
    if (s.rules.some((t) => t.id === r.id)) loosening.push(`rules.${r.id}: a team rule has this id; the personal file can't change or replace it`);
    else s.rules.push({ ...r });
  }
  if (personal.has?.tracks) loosening.push('tracks: set by the team settings only');
  if (personal.has?.clientProject) loosening.push('clientProject: set by the team settings only');
  s.preferences = personal.preferences || {};
  return { settings: s, loosening };
}

// What applies in a project. `team` and `personal` are { status: 'none'|'ok'|'broken', data, errors, file };
// `profile` is the saved profile (only used when the team's settings are broken).
// Returns { status, settings, loosening, warnings, message } where status is that of the team's settings.
export function resolveSettings({ team, personal, profile }) {
  const warnings = [];
  let p = null;
  if (personal?.status === 'ok') {
    const v = validatePersonal(personal.data);
    if (v.ok) { p = v.value; warnings.push(...v.warnings.map((w) => `${personal.file}: ${w}`)); }
    else warnings.push(`${personal.file} is ignored: ${v.errors.join('; ')}`);
  } else if (personal?.status === 'broken') warnings.push(`${personal.file} is ignored: ${personal.errors.join('; ')}`);

  if (!team || team.status === 'none') return { status: 'none', settings: null, loosening: [], warnings, message: null };
  const v = team.status === 'ok' ? validateSettings(team.data) : { ok: false, errors: team.errors || [] };
  if (v.ok) {
    warnings.push(...v.warnings.map((w) => `${team.file}: ${w}`));
    const { settings, loosening } = mergePersonal(teamDefaults(v.value), p);
    return { status: 'ok', settings, loosening, warnings, message: null };
  }
  // Broken: fail safe. Every rule on; the confirmed lists come from the defaults and the profile's candidates;
  // the project's own rules and the two loosening lists pause, because broken must never mean looser.
  const facts = profile?.facts || {};
  const candidates = facts.protectedBranchCandidates?.status === 'found' ? facts.protectedBranchCandidates.value : [];
  const settings = {
    guardrails: Object.fromEntries(GUARDRAILS.map((g) => [g, true])),
    protectedBranches: union(DEFAULT_PROTECTED, candidates),
    generated: (profile?.suggestions?.generated || []).map((g) => ({ path: g.path, regenerate: g.regenerate || null })),
    secrets: { allow: [] }, locations: { allowed: [], protected: [] }, rules: [], preferences: {},
  };
  const merged = mergePersonal(settings, p);
  merged.settings.locations.allowed = [];
  merged.settings.secrets.allow = [];
  return { status: 'broken', settings: merged.settings, loosening: merged.loosening, warnings, message: brokenMessage(team.file, v.errors) };
}

// The loud message for broken settings: the file, where it's wrong (never a value), what still applies, how to fix.
export function brokenMessage(file, errors) {
  return `Cartwright's guardrail settings in ${file} can't be used: ${errors.join('; ')}. Built-in protections are on and the project's own rules are paused. Fix the file (or ask the person to) through a pull request.`;
}

// Whether `after` is at least as strict as `before` (both team settings, as teamDefaults returns them).
// Reserved for messages and the later auditor; uses the same rows as mergePersonal.
export function isTightening(before, after) {
  const sub = (a, b) => a.every((x) => b.includes(x));
  return GUARDRAILS.every((g) => !before.guardrails[g] || after.guardrails[g])
    && sub(before.protectedBranches, after.protectedBranches)
    && sub(before.generated.map((g) => g.path), after.generated.map((g) => g.path))
    && sub(before.locations.protected, after.locations.protected)
    && sub(after.locations.allowed, before.locations.allowed)
    && sub(after.secrets.allow, before.secrets.allow)
    && before.rules.every((r) => after.rules.some((x) => JSON.stringify(x) === JSON.stringify(r)));
}

// A new team settings file, keeping everything in `base` (an existing valid file's raw object) that the
// options don't set, including rule switches a later Cartwright added. Options are what the person confirmed;
// each list option replaces the list.
export function buildSettings(base, { protectedBranches, generated, secretsAllow, allowed, protect, clientProject } = {}) {
  const s = JSON.parse(JSON.stringify(base || {}));
  s.$comment = SETTINGS_COMMENT;
  s.cartwright = 'settings';
  s.version = SETTINGS_VERSION;
  s.guardrails = { ...(isObj(s.guardrails) ? s.guardrails : {}), ...Object.fromEntries(GUARDRAILS.map((g) => [g, s.guardrails?.[g] !== false])) };
  if (protectedBranches) s.protectedBranches = protectedBranches;
  else if (!s.protectedBranches) s.protectedBranches = [...DEFAULT_PROTECTED];
  if (generated) s.generated = generated;
  else if (!s.generated) s.generated = [];
  s.secrets = { allow: [], ...(isObj(s.secrets) ? s.secrets : {}) };
  if (secretsAllow) s.secrets.allow = secretsAllow;
  s.locations = { allowed: [], protected: [], ...(isObj(s.locations) ? s.locations : {}) };
  if (allowed) s.locations.allowed = allowed;
  if (protect) s.locations.protected = protect;
  if (!s.rules) s.rules = [];
  if (clientProject !== undefined) s.clientProject = clientProject;
  s.tracks = { ...(isObj(s.tracks) ? s.tracks : {}), $comment: TRACKS_COMMENT, enabled: s.tracks?.enabled ?? false };
  return s;
}
