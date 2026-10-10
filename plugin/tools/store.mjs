// Where a project's Cartwright profile, team settings and personal file live, and how they're read and written.
// Three storage modes, looked up in this order (first found wins):
//   folder      .cartwright/profile.json, settings.json, personal.json (+ .gitignore for personal.json, README.md)
//   agents-md   one marked section in the project's AGENTS.md holding the profile and settings; personal file
//               on the machine
//   machine     <state>/projects/<key>/profile.json, settings.json, personal.json; nothing in the repo
// <state> is $CARTWRIGHT_STATE_DIR or ~/.cartwright; <key> is the first 16 hex characters of the sha256 of the
// project root's real path. Shipped in the plugin as tools/store.mjs. No dependencies.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  let pos = 0, n = 0, fence = null, fenceLine = 0, b = -1, e = -1, extra = false;
  for (const raw of text.split('\n')) {
    const start = pos;
    pos += raw.length + 1;
    n++;
    const line = raw.replace(/\r$/, '');
    const f = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (f) { if (!fence) { fence = f[1][0]; fenceLine = n; } else if (f[1][0] === fence) fence = null; continue; }
    // Inside a fence, or an indented code block (four spaces or a tab): not a marker.
    if (fence || !/^ {0,3}\S/.test(line)) continue;
    const t = line.trim(), at = start + line.indexOf(t);
    if (t.startsWith(BEGIN_PREFIX) && t.endsWith('-->')) { if (b < 0) b = at; else if (e < 0) extra = true; }
    else if (t === END) { if (b < 0 || e >= 0) extra = true; else e = at; }
  }
  return { b, e, extra, openFence: fence ? fenceLine : null };
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
  // Appended after a code fence that's never closed, the section would sit inside it and never be found again.
  const open = cur.status === 'none' && findMarkers(text).openFence;
  if (open) throw new Error(`${AGENTS_FILE} has an unclosed code fence at line ${open}; close it and run again.`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const section = renderSection(parts, eol);
  if (cur.status === 'ok') return text.slice(0, cur.start) + section + text.slice(cur.end);
  if (!text.length) return section + eol;
  return text.endsWith(eol) ? text + eol + section + eol : text + eol + eol + section;
}

const folderPath = (root, f) => join(root, FOLDER, f);
// Which storage modes hold something for this project, in lookup order.
// AGENTS.md under exactly that name: { path }, or { path: null, variant } when only another case exists (Agents.md),
// which agents don't read as AGENTS.md on a case-sensitive disk, so Cartwright doesn't either, on any disk.
export function agentsFile(root) {
  let names; try { names = readdirSync(root); } catch { return { path: join(root, AGENTS_FILE) }; }
  if (names.includes(AGENTS_FILE)) return { path: join(root, AGENTS_FILE) };
  const variant = names.find((x) => x.toLowerCase() === AGENTS_FILE.toLowerCase());
  return variant ? { path: null, variant } : { path: join(root, AGENTS_FILE) };
}

// Which storage modes hold something, in lookup order, and notes for the person. An unreadable .cartwright/ folder
// counts as found (its existence is the evidence of profiling) and is broken; an unreadable AGENTS.md on its own
// isn't evidence of profiling, so the project counts as unprofiled, with a note.
function scan(root) {
  const out = [], notes = [];
  let folder; try { folder = readdirSync(join(root, FOLDER)); } catch (e) { folder = missing(e) ? [] : null; }
  if (folder === null || ['profile.json', 'settings.json'].some((f) => folder.includes(f))) out.push('folder');
  const af = agentsFile(root);
  if (af.variant) notes.push(`This project has ${af.variant}, not ${AGENTS_FILE}; Cartwright (like agents on most systems) only reads ${AGENTS_FILE}.`);
  const agents = af.path ? readOrError(af.path) : { text: null };
  if (agents.error) notes.push(`${AGENTS_FILE} can't be read (${agents.error}), so any Cartwright section in it is ignored.`);
  else if (agents.text !== null && readSection(agents.text).status !== 'none') out.push('agents-md');
  if (['profile.json', 'settings.json'].some((f) => existsSync(join(machineDir(root), f)))) out.push('machine');
  return { out, notes };
}
export const found = (root) => scan(root).out;

// Where the personal file lives for a storage mode: in the folder (git-ignored) or on this machine.
export const personalPath = (root, mode) => (mode === 'folder' ? folderPath(root, 'personal.json') : join(machineDir(root), 'personal.json'));
const personalLabel = (root, mode) => (mode === 'folder' ? `${FOLDER}/personal.json` : personalPath(root, mode));

// Everything stored for a project. `mode` picks one; by default the first found in lookup order.
// Returns { mode, found, profile, settings, personal }, each file as { status, data, errors, file }.
export function load(root, mode) {
  const { out: all, notes } = scan(root);
  const m = mode || all[0] || null;
  const none = (file) => ({ status: 'none', file });
  if (!m) return { mode: null, notes, found: all, profile: none(null), settings: none(null), personal: none(null) };
  const personal = readJsonFile(personalPath(root, m), personalLabel(root, m));
  if (m === 'folder') return { mode: m, notes, found: all, profile: readJsonFile(folderPath(root, 'profile.json'), `${FOLDER}/profile.json`), settings: readJsonFile(folderPath(root, 'settings.json'), `${FOLDER}/settings.json`), personal };
  if (m === 'machine') return { mode: m, notes, found: all, profile: readJsonFile(join(machineDir(root), 'profile.json'), join(machineDir(root), 'profile.json')), settings: readJsonFile(join(machineDir(root), 'settings.json'), join(machineDir(root), 'settings.json')), personal };
  const af = agentsFile(root);
  const { text, error } = af.path ? readOrError(af.path) : { text: null };
  if (error) { const b = { status: 'broken', errors: [`the file can't be read (${error})`], file: AGENTS_FILE }; return { mode: m, notes, found: all, profile: b, settings: b, personal }; }
  const sec = text === null ? { status: 'none' } : readSection(text);
  if (sec.status === 'none') return { mode: m, notes, found: all, profile: none(AGENTS_FILE), settings: none(AGENTS_FILE), personal };
  if (sec.status === 'broken') { const b = { status: 'broken', errors: sec.errors, file: AGENTS_FILE }; return { mode: m, notes, found: all, profile: b, settings: b, personal }; }
  return { mode: m, notes, found: all, profile: sec.profile, settings: sec.settings, personal };
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
    // Write a temporary file next to it, then rename: a reader never sees half a file. The file keeps its mode.
    let keep; try { keep = statSync(dest).mode & 0o7777; } catch { /* a new file */ }
    const tmp = `${dest}.cartwright-${process.pid}.tmp`;
    writeFileSync(tmp, text);
    if (keep !== undefined) chmodSync(tmp, keep);
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
    const af = agentsFile(root);
    if (!af.path) throw new Error(`This project has ${af.variant}, not ${AGENTS_FILE}: agents look for ${AGENTS_FILE} exactly. Rename it (git mv ${af.variant} ${AGENTS_FILE}) and run again, or choose another store.`);
    const next = withSection(readText(af.path), { summary, profile, settings });
    if (readSection(next).status !== 'ok') throw new Error(`the ${AGENTS_FILE} section wouldn't be readable after writing; nothing was changed.`);
    put(af.path, next, AGENTS_FILE);
    if (readSection(readText(af.path) ?? '').status !== 'ok') throw new Error(`the section written to ${AGENTS_FILE} can't be found when it's read back; check the file.`);
  }
  return changed;
}
