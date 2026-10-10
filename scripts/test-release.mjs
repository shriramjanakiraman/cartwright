#!/usr/bin/env node
// One command for testing a change or a release, at the depth it deserves (see documentation/14).
//
//   quick  feature and bugfix work, patch releases:  checks + the profile test and the bare-machine test without
//                                                     tool downloads (at the same time) + the guard test
//   minor  minor releases:                            + tool downloads and smoke test, Claude Code's tools
//                                                       scenario, a fresh Copilot install and its session start
//   major  major releases:                            + a real pull request in the test client, Claude Code
//                                                       through both client-setup conversations, Copilot's
//                                                       session start and teammate path, and the manual checks
//
// Usage: node scripts/test-release.mjs --level quick|minor|major [--report <file>] [--keep]
// Builds the plugin first and tests that build. Env: GH_TOKEN (needed from "quick" up: the bare-machine test
// clones the fixture repos), CLAUDE_BIN, AGENT_MODEL — as for e2e.mjs and agent-e2e.mjs.
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
const PLANS = {
  quick: [
    ['Checks (validate, scrub, build, registry)', 'npm', ['run', '-s', 'check']],
    ['Profile test (deterministic, offline)', 'node', ['scripts/e2e-profile.mjs', '--plugin', './plugin', ...keep], 'together'],
    ['Bare-machine test (no tool downloads)', 'node', ['scripts/e2e.mjs', '--plugin', './plugin', '--fast', ...keep], 'together'],
    GUARD,
  ],
  minor: [
    ['Checks (validate, scrub, build, registry)', 'npm', ['run', '-s', 'check']],
    ['Profile test (deterministic, offline)', 'node', ['scripts/e2e-profile.mjs', '--plugin', './plugin', ...keep], 'together'],
    ['Bare-machine test (full)', 'node', ['scripts/e2e.mjs', '--plugin', './plugin', ...keep], 'together'],
    GUARD,
    ['Agents: Claude Code tools, Copilot install and session start', 'node', ['scripts/agent-e2e.mjs', '--plugin', './plugin', '--scenarios', 'claude-tools,copilot-install,copilot-session-start', ...keep]],
  ],
  major: [
    ['Checks (validate, scrub, build, registry)', 'npm', ['run', '-s', 'check']],
    ['Profile test (deterministic, offline)', 'node', ['scripts/e2e-profile.mjs', '--plugin', './plugin', ...keep], 'together'],
    ['Bare-machine test (full, with a real pull request)', 'node', ['scripts/e2e.mjs', '--plugin', './plugin', '--pr', ...keep], 'together'],
    GUARD,
    ['Agents: every scenario', 'node', ['scripts/agent-e2e.mjs', '--plugin', './plugin', ...keep]],
  ],
};
const MANUAL = `### Still to check by hand (major releases)

These need an interactive prompt or an agent this framework can't drive here:

- [ ] **Codex:** open the test client project (with the kit) in Codex; the "${'<code>'} project skills" marketplace
      appears with both plugins enabled, approve the Cartwright hook once (\`/hooks\`), and the project skill is listed.
- [ ] **Claude Code, teammate prompt:** clone the test client project with the kit, open it, trust the folder;
      Claude Code offers both plugins. (Headless runs can't answer the trust prompt.)
- [ ] **VS Code:** *Install Plugin From Source* with the core repo works (workspace recommendations are still
      ignored by VS Code, microsoft/vscode#327404), and a new chat in a fresh git folder gets the \`[cartwright]\`
      session-start context (the setup offer, the missing-tools note).
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
if (LEVEL === 'major') out.push(MANUAL);
out.splice(3, 0, '| | Part |', '|---|---|', ...summary.map(([l, ok]) => `| ${ok ? '✅' : '❌'} | ${l} |`), '');

const report = out.join('\n');
console.log(report);
if (opt('--report')) writeFileSync(opt('--report'), report + '\n');
process.exit(summary.every(([, ok]) => ok) ? 0 : 1);
