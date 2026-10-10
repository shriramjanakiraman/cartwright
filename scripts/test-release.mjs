#!/usr/bin/env node
// One command for testing a change or a release, at the depth it deserves (see documentation/14).
//
//   quick  feature and bugfix work (no agents):       checks + the Codex trust-hash check + the profile test and the
//                                                     bare-machine test without tool downloads (at the same time)
//                                                     + the guard test
//   minor  patch and minor releases (ADR 0013):       + tool downloads and smoke test, and the agent scenarios in
//                                                       Claude Code, Copilot CLI and Codex at the same time (one
//                                                       stream per agent): Claude Code's tools scenario, Copilot's
//                                                       install and session start, and the phase 1 grounding and
//                                                       block scenarios in all three; the manual checks
//   major  major releases:                            + a real pull request in the test client, and the long setup
//                                                       conversations (Claude Code's first run and both client-setup
//                                                       conversations, Copilot's teammate path)
//
// Usage: node scripts/test-release.mjs --level quick|minor|major [--report <file>] [--keep]
// Builds the plugin first and tests that build. Env: GH_TOKEN (needed from "quick" up: the bare-machine test
// clones the fixture repos), CLAUDE_BIN, AGENT_MODEL, CODEX_MODEL — as for e2e.mjs and agent-e2e.mjs. From "minor"
// up, Codex needs a sign-in (~/.codex/auth.json; a copy is used and deleted) and runs through npx.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const LEVEL = opt('--level', 'quick');
const keep = args.includes('--keep') ? ['--keep'] : [];

// The guard test runs on its own, after the suites that run together, because it measures the hook's timing.
const GUARD = ['Guard test (deterministic, offline)', 'node', ['scripts/e2e-guard.mjs', '--plugin', './plugin', ...keep]];
// The agent scenarios run as one process per agent, at the same time.
const AGENTS = (set) => [['Claude Code', 'claude'], ['Copilot CLI', 'copilot'], ['Codex', 'codex']].map(([name, id]) =>
  [`Agents (${set}): ${name}`, 'node', ['scripts/agent-e2e.mjs', '--plugin', './plugin', '--set', set, '--agent', id, ...keep], 'agents']);
const TRUST = ['Codex trust hashes match hooks.json', 'node', ['scripts/codex-trust.mjs', 'check', '--plugin', './plugin']];
const PLANS = {
  quick: [
    ['Checks (validate, scrub, build, registry)', 'npm', ['run', '-s', 'check']],
    TRUST,
    ['Profile test (deterministic, offline)', 'node', ['scripts/e2e-profile.mjs', '--plugin', './plugin', ...keep], 'together'],
    ['Bare-machine test (no tool downloads)', 'node', ['scripts/e2e.mjs', '--plugin', './plugin', '--fast', ...keep], 'together'],
    GUARD,
  ],
  minor: [
    ['Checks (validate, scrub, build, registry)', 'npm', ['run', '-s', 'check']],
    TRUST,
    ['Profile test (deterministic, offline)', 'node', ['scripts/e2e-profile.mjs', '--plugin', './plugin', ...keep], 'together'],
    ['Bare-machine test (full)', 'node', ['scripts/e2e.mjs', '--plugin', './plugin', ...keep], 'together'],
    GUARD,
    ...AGENTS('minor'),
  ],
  major: [
    ['Checks (validate, scrub, build, registry)', 'npm', ['run', '-s', 'check']],
    TRUST,
    ['Profile test (deterministic, offline)', 'node', ['scripts/e2e-profile.mjs', '--plugin', './plugin', ...keep], 'together'],
    ['Bare-machine test (full, with a real pull request)', 'node', ['scripts/e2e.mjs', '--plugin', './plugin', '--pr', ...keep], 'together'],
    GUARD,
    ...AGENTS('major'),
  ],
};
const MANUAL = `### Still to check by hand (minor and major releases)

These need an interactive prompt or an agent this framework can't drive here:

- [ ] **Codex, interactive:** open the test client project (with the kit) in Codex; the "${'<code>'} project skills"
      marketplace appears with both plugins enabled, \`/hooks\` asks once to approve Cartwright's hooks, and the
      project skill is listed. (The agent scenarios pre-seed the hooks' trust instead of answering that prompt.)
- [ ] **Claude Code, teammate prompt:** clone the test client project with the kit, open it, trust the folder;
      Claude Code offers both plugins. (Headless runs can't answer the trust prompt.)
- [ ] **VS Code:** *Install Plugin From Source* with the core repo works (workspace recommendations are still
      ignored by VS Code, microsoft/vscode#327404), and a new chat in a fresh git folder gets the \`[cartwright]\`
      session-start context (the setup offer, the missing-tools note). In a profiled project, the chat gets the
      profile summary, and asking it to push to \`main\` is blocked with Cartwright's message.
- [ ] **Windows**, if anyone on the team uses it: \`node tools/run.mjs --check\` and one tool run.
`;

if (!PLANS[LEVEL]) { console.error(`test-release: --level must be ${Object.keys(PLANS).join(', ')}`); process.exit(2); }

const build = spawnSync('npm', ['run', '-s', 'build'], { cwd: ROOT, encoding: 'utf8' });
const out = [`# Cartwright test report: ${LEVEL}`, '', `${new Date().toISOString()} · ${spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()} (${spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()})`, ''];
const summary = [['Build', build.status === 0]];
if (build.status !== 0) out.push('Build failed:', '```', build.stderr.trim(), '```');

// Run one part: { status, stdout, stderr, secs }.
const runPart = (cmd, a) => new Promise((done) => {
  const t = Date.now();
  const child = spawn(cmd, a, { cwd: ROOT, env: process.env });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3600000);
  child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr, secs: Math.round((Date.now() - t) / 1000) }); });
});
// Parts marked with the same group (the fourth field) run at the same time; the report keeps the plan's order.
const plan = PLANS[LEVEL];
for (let i = 0; i < plan.length;) {
  let j = i + 1;
  while (plan[i][3] && j < plan.length && plan[j][3] === plan[i][3]) j++;
  const parts = plan.slice(i, j);
  const results = await Promise.all(parts.map(([, cmd, a]) => runPart(cmd, a)));
  parts.forEach(([label], k) => {
    const r = results[k];
    summary.push([label, r.status === 0]);
    out.push(`## ${r.status === 0 ? '✅' : '❌'} ${label} (${r.secs}s${parts.length > 1 ? ', alongside the others in its group' : ''})`, '');
    const body = (r.stdout || '').trim();
    out.push(body.startsWith('##') || body.startsWith('|') ? body.replace(/^## .*\n+/, '') : '```\n' + (body + '\n' + (r.stderr || '')).trim().slice(-3000) + '\n```', '');
  });
  i = j;
}
if (LEVEL !== 'quick') out.push(MANUAL);
out.splice(3, 0, '| | Part |', '|---|---|', ...summary.map(([l, ok]) => `| ${ok ? '✅' : '❌'} | ${l} |`), '');

const report = out.join('\n');
console.log(report);
if (opt('--report')) writeFileSync(opt('--report'), report + '\n');
process.exit(summary.every(([, ok]) => ok) ? 0 : 1);
