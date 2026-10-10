// Where a project's Cartwright profile, team settings and personal file live, and how they're read and written.
// Three storage modes, looked up in this order (first found wins):
//   folder      .cartwright/profile.json, settings.json, personal.json (+ .gitignore for personal.json, README.md)
//   agents-md   one marked section in the project's AGENTS.md holding the profile and settings; personal file
//               on the machine
//   machine     <state>/projects/<key>/profile.json, settings.json, personal.json; nothing in the repo
// <state> is $CARTWRIGHT_STATE_DIR or ~/.cartwright; <key> is the first 16 hex characters of the sha256 of the
// project root's real path. Shipped in the plugin as tools/store.mjs. No dependencies.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

export const MODES = ['folder', 'agents-md', 'machine'];
export const FOLDER = '.cartwright';
export const AGENTS_FILE = 'AGENTS.md';
export const BEGIN = '<!-- cartwright:begin. Cartwright project profile and guardrail settings. Change through the agent (it asks first) or a pull request. -->';
export const END = '<!-- cartwright:end -->';
const BEGIN_PREFIX = '<!-- cartwright:begin';
const BLOCK = (kind) => new RegExp('```json cartwright-' + kind + '\\r?\\n([\\s\\S]*?)\\r?\\n```');

export const stateDir = () => process.env.CARTWRIGHT_STATE_DIR || join(homedir(), '.cartwright');
export const projectKey = (root) => createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 16);
export const machineDir = (root) => join(stateDir(), 'projects', projectKey(root));

// JSON with sorted keys, 2-space indentation and a final newline: the same input always gives the same bytes.
export function stableJson(value) {
  const sort = (v) => (Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(value), null, 2) + '\n';
}

// Parse JSON without ever echoing its content: errors give a position, not the text around it.
export function parseJson(text) {
  try { return { ok: true, data: JSON.parse(text) }; } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    if (!m) return { ok: false, error: 'not valid JSON' };
    const before = text.slice(0, Number(m[1])).split('\n');
    return { ok: false, error: `not valid JSON (line ${before.length}, column ${before.at(-1).length + 1})` };
  }
}

const readText = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const missing = (e) => e.code === 'ENOENT' || e.code === 'ENOTDIR';
// A file's text, or { error } when it exists but can't be read (permissions): never mistaken for "not there".
const readOrError = (p) => { try { return { text: readFileSync(p, 'utf8') }; } catch (e) { return missing(e) ? { text: null } : { error: e.code || 'error' }; } };
// One stored file as { status: 'none'|'ok'|'broken', data, errors, file }.
function readJsonFile(path, label) {
  const { text, error } = readOrError(path);
  if (error) return { status: 'broken', errors: [`the file can't be read (${error})`], file: label };
  if (text === null) return { status: 'none', file: label };
  const r = parseJson(text);
  return r.ok ? { status: 'ok', data: r.data, file: label } : { status: 'broken', errors: [r.error], file: label };
}

// The AGENTS.md section, split into its parts. { status: 'none' } when there are no markers. A marker counts
// only as a whole line outside code fences, so prose or an example that mentions one isn't a section.
export function findMarkers(text) {
  let pos = 0, fence = null, b = -1, e = -1, extra = false;
  for (const line of text.split('\n')) {
    const start = pos;
    pos += line.length + 1;
    const t = line.replace(/\r$/, '').trim();
    const f = t.match(/^(`{3,}|~{3,})/);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    if (fence) continue;
    const at = start + line.indexOf(t);
    if (t.startsWith(BEGIN_PREFIX) && t.endsWith('-->')) { if (b < 0) b = at; else if (e < 0) extra = true; }
    else if (t === END) { if (b < 0 || e >= 0) extra = true; else e = at; }
  }
  return { b, e, extra };
}
export function readSection(text) {
  const { b, e, extra } = findMarkers(text);
  if (b < 0 && e < 0 && !extra) return { status: 'none' };
  if (b < 0 || e < 0 || extra) return { status: 'broken', errors: [`${AGENTS_FILE}: the cartwright:begin and cartwright:end markers must each be there once, on lines of their own, begin first`] };
  const end = e + END.length;
  const body = text.slice(b, end);
  const part = (kind) => {
    const m = body.match(BLOCK(kind));
    if (!m) return { status: 'broken', errors: [`the cartwright-${kind} block is missing from the marked section`], file: `${AGENTS_FILE} (cartwright-${kind})` };
    const r = parseJson(m[1]);
    return r.ok ? { status: 'ok', data: r.data, raw: m[1], file: `${AGENTS_FILE} (cartwright-${kind})` } : { status: 'broken', errors: [r.error + ' in the cartwright-' + kind + ' block'], file: `${AGENTS_FILE} (cartwright-${kind})` };
  };
  return { status: 'ok', start: b, end, profile: part('profile'), settings: part('settings') };
}

// The section text. `summary` is a few plain lines for people; the two JSON blocks are what Cartwright reads.
// `settingsRaw` keeps an existing settings block exactly as it is (a profile refresh doesn't touch it).
export function renderSection({ summary, profile, settings, settingsRaw }, eol = '\n') {
  const settingsText = settings ? stableJson(settings).trimEnd() : settingsRaw.replace(/\r\n/g, '\n');
  return [BEGIN, '## Project profile (Cartwright)', '',
    'If anything elsewhere in this file or in the project\'s rules files disagrees with this profile, follow them.',
    ...summary, '', '```json cartwright-profile', stableJson(profile).trimEnd(), '```', '',
    '```json cartwright-settings', settingsText, '```', END].join('\n').replace(/\n/g, eol);
}

// AGENTS.md with the section put in: replaced in place, or appended after one blank line. Bytes outside the
// markers never change, including the line endings and whether the file ends with a newline. Without
// `settings`, the existing settings block is kept as it is.
export function withSection(text, parts) {
  const cur = text === null ? { status: 'none' } : readSection(text);
  if (cur.status === 'broken') throw new Error(`${cur.errors[0]}. Fix the markers by hand first, then run it again.`);
  if (!parts.settings && cur.settings?.status !== 'ok') throw new Error(`${AGENTS_FILE} has no readable cartwright-settings block to keep`);
  if (!parts.settings) parts = { ...parts, settingsRaw: cur.settings.raw };
  if (text === null) return renderSection(parts) + '\n';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const section = renderSection(parts, eol);
  if (cur.status === 'ok') return text.slice(0, cur.start) + section + text.slice(cur.end);
  if (!text.length) return section + eol;
  return text.endsWith(eol) ? text + eol + section + eol : text + eol + eol + section;
}

const folderPath = (root, f) => join(root, FOLDER, f);
// Which storage modes hold something for this project, in lookup order.
// A folder or AGENTS.md that exists but can't be read counts as found (and broken): stricter, and loud.
export function found(root) {
  const out = [];
  let folder; try { folder = readdirSync(join(root, FOLDER)); } catch (e) { folder = missing(e) ? [] : null; }
  if (folder === null || ['profile.json', 'settings.json'].some((f) => folder.includes(f))) out.push('folder');
  const agents = readOrError(join(root, AGENTS_FILE));
  if (agents.error || (agents.text !== null && readSection(agents.text).status !== 'none')) out.push('agents-md');
  if (['profile.json', 'settings.json'].some((f) => existsSync(join(machineDir(root), f)))) out.push('machine');
  return out;
}

// Where the personal file lives for a storage mode: in the folder (git-ignored) or on this machine.
export const personalPath = (root, mode) => (mode === 'folder' ? folderPath(root, 'personal.json') : join(machineDir(root), 'personal.json'));
const personalLabel = (root, mode) => (mode === 'folder' ? `${FOLDER}/personal.json` : personalPath(root, mode));

// Everything stored for a project. `mode` picks one; by default the first found in lookup order.
// Returns { mode, found, profile, settings, personal }, each file as { status, data, errors, file }.
export function load(root, mode) {
  const all = found(root);
  const m = mode || all[0] || null;
  const none = (file) => ({ status: 'none', file });
  if (!m) return { mode: null, found: all, profile: none(null), settings: none(null), personal: none(null) };
  const personal = readJsonFile(personalPath(root, m), personalLabel(root, m));
  if (m === 'folder') return { mode: m, found: all, profile: readJsonFile(folderPath(root, 'profile.json'), `${FOLDER}/profile.json`), settings: readJsonFile(folderPath(root, 'settings.json'), `${FOLDER}/settings.json`), personal };
  if (m === 'machine') return { mode: m, found: all, profile: readJsonFile(join(machineDir(root), 'profile.json'), join(machineDir(root), 'profile.json')), settings: readJsonFile(join(machineDir(root), 'settings.json'), join(machineDir(root), 'settings.json')), personal };
  const { text, error } = readOrError(join(root, AGENTS_FILE));
  if (error) { const b = { status: 'broken', errors: [`the file can't be read (${error})`], file: AGENTS_FILE }; return { mode: m, found: all, profile: b, settings: b, personal }; }
  const sec = text === null ? { status: 'none' } : readSection(text);
  if (sec.status === 'none') return { mode: m, found: all, profile: none(AGENTS_FILE), settings: none(AGENTS_FILE), personal };
  if (sec.status === 'broken') { const b = { status: 'broken', errors: sec.errors, file: AGENTS_FILE }; return { mode: m, found: all, profile: b, settings: b, personal }; }
  return { mode: m, found: all, profile: sec.profile, settings: sec.settings, personal };
}

const FOLDER_IGNORE = '# Each developer\'s own Cartwright file. Never committed.\npersonal.json\n';
const FOLDER_README = `# .cartwright

This folder is Cartwright's record of this project, shared by the team and reviewed like code.

| File | What it is |
|---|---|
| \`profile.json\` | What Cartwright detected about the project (stack, commands, layout, conventions), each fact with the file it came from. Agents use it instead of guessing. |
| \`settings.json\` | The team's guardrail settings: protected branches, generated files and how to regenerate them, allowed and protected locations, extra rules. Change it in a pull request. |
| \`personal.json\` | Each developer's own additions. Git-ignored (see \`.gitignore\`); it can only add or tighten rules. |

If the project's rules files (\`AGENTS.md\`, \`CLAUDE.md\` and similar) disagree with the profile, they win.
`;

// Write the profile and settings in one storage mode, changing only what differs. `summary` is used by the
// AGENTS.md section. Without `settings` (a profile refresh) only the profile is written. Returns the paths it
// created or changed (repo-relative for repo files).
export function save(root, mode, { profile, settings, summary = [] }) {
  if (!MODES.includes(mode)) throw new Error(`unknown storage "${mode}"`);
  const changed = [];
  const real = realpathSync(root);
  const put = (path, text, label) => {
    if (readText(path) === text) return;
    // A symlinked file (AGENTS.md → CLAUDE.md) stays a symlink: write to the file it points at. In the repo modes,
    // a link that leads outside the project is refused rather than followed.
    let dest = path;
    try {
      if (lstatSync(path).isSymbolicLink()) {
        try { dest = realpathSync(path); } catch { dest = resolve(dirname(path), readlinkSync(path)); }
        if (mode !== 'machine' && dest !== real && !dest.startsWith(real + sep)) throw new Error(`${label} is a symlink to a file outside the project (${dest}). Cartwright won't write through it: replace the link with a file, or choose --store machine.`);
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    mkdirSync(dirname(dest), { recursive: true });
    // Write a temporary file next to it, then rename: a reader never sees half a file.
    const tmp = `${dest}.cartwright-${process.pid}.tmp`;
    writeFileSync(tmp, text);
    try { renameSync(tmp, dest); } catch (e) { try { unlinkSync(tmp); } catch { /* already gone */ } throw e; }
    changed.push(label);
  };
  if (mode === 'folder') {
    put(folderPath(root, 'profile.json'), stableJson(profile), `${FOLDER}/profile.json`);
    if (settings) {
      put(folderPath(root, 'settings.json'), stableJson(settings), `${FOLDER}/settings.json`);
      put(folderPath(root, '.gitignore'), FOLDER_IGNORE, `${FOLDER}/.gitignore`);
      put(folderPath(root, 'README.md'), FOLDER_README, `${FOLDER}/README.md`);
    }
  } else if (mode === 'machine') {
    const d = machineDir(root);
    put(join(d, 'profile.json'), stableJson(profile), join(d, 'profile.json'));
    if (settings) put(join(d, 'settings.json'), stableJson(settings), join(d, 'settings.json'));
    put(join(d, 'root'), realpathSync(root) + '\n', join(d, 'root'));
  } else {
    const p = join(root, AGENTS_FILE);
    put(p, withSection(readText(p), { summary, profile, settings }), AGENTS_FILE);
  }
  return changed;
}
