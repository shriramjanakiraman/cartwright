// Where a project's Cartwright profile, team settings and personal file live, and how they're read and written.
// Three storage modes, looked up in this order (first found wins):
//   folder      .cartwright/profile.json, settings.json, personal.json (+ .gitignore for personal.json, README.md)
//   agents-md   one marked section in the project's AGENTS.md holding the profile and settings; personal file
//               on the machine
//   machine     <state>/projects/<key>/profile.json, settings.json, personal.json; nothing in the repo
// <state> is $CARTWRIGHT_STATE_DIR or ~/.cartwright; <key> is the first 16 hex characters of the sha256 of the
// project root's real path. Shipped in the plugin as tools/store.mjs. No dependencies.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
// One stored file as { status: 'none'|'ok'|'broken', data, errors, file }.
function readJsonFile(path, label) {
  if (!existsSync(path)) return { status: 'none', file: label };
  const text = readText(path);
  if (text === null) return { status: 'broken', errors: ["can't be read"], file: label };
  const r = parseJson(text);
  return r.ok ? { status: 'ok', data: r.data, file: label } : { status: 'broken', errors: [r.error], file: label };
}

// The AGENTS.md section, split into its parts. { status: 'none' } when there are no markers.
export function readSection(text) {
  const b = text.indexOf(BEGIN_PREFIX), e = text.indexOf(END);
  if (b < 0 && e < 0) return { status: 'none' };
  if (b < 0 || e < 0 || e < b) return { status: 'broken', errors: [`${AGENTS_FILE}: the cartwright:begin and cartwright:end markers must both be there, begin first`] };
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
export function found(root) {
  const out = [];
  if (['profile.json', 'settings.json'].some((f) => existsSync(folderPath(root, f)))) out.push('folder');
  const agents = readText(join(root, AGENTS_FILE));
  if (agents !== null && readSection(agents).status !== 'none') out.push('agents-md');
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
  const text = readText(join(root, AGENTS_FILE));
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
  const put = (path, text, label) => {
    if (readText(path) === text) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
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
