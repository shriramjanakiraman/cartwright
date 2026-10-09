#!/usr/bin/env node
// The pull request side of the duplicate check (duplicate-check workflow, core and overlays):
//   - one comment per likely repeat, on the skill's file, with the other skill and a suggestion
//     (never posted twice for the same pair, resolved or not)
//   - a "Request changes" review while any of those comments is unresolved, and a failing check
//   - once every one is resolved: the review is dismissed and the check passes
// Anyone may resolve a comment, after replying with the decision. On a plan with rulesets, the required
// check and "require conversation resolution" make this a hard block; until then it's a strong signal and
// branch-guard opens an issue if a pull request merges with one still open.
//
// Usage (in CI): node scripts/duplicate-review.mjs <findings.json>
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, HEAD_SHA, GITHUB_STEP_SUMMARY (optional)
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MARKER = 'duplicate-check:';
const { GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO, PR_NUMBER: PR, HEAD_SHA: SHA, GITHUB_STEP_SUMMARY: SUMMARY } = process.env;
const BOT = 'github-actions[bot]';
const [owner, name] = (REPO || '/').split('/');

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method, body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
const graphql = (query, variables) => gh('/graphql', { method: 'POST', body: { query, variables } }).then((r) => {
  if (r.errors) throw new Error(JSON.stringify(r.errors));
  return r.data;
});

// Every review thread on the pull request that this check opened: { key, resolved }.
export async function duplicateThreads(repoOwner, repoName, number, query = graphql) {
  const threads = [];
  let after = null;
  do {
    const d = await query(`query($o:String!,$n:String!,$pr:Int!,$after:String){repository(owner:$o,name:$n){pullRequest(number:$pr){
      reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved comments(first:1){nodes{body}}}}}}}`,
    { o: repoOwner, n: repoName, pr: Number(number), after });
    const page = d.repository.pullRequest.reviewThreads;
    for (const t of page.nodes) {
      const m = (t.comments.nodes[0]?.body || '').match(new RegExp(`<!-- ${MARKER}(\\S+) -->`));
      if (m) threads.push({ key: m[1], resolved: t.isResolved });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return threads;
}

const comment = (f) => `**Possible repeat of an existing skill.** \`${f.skill}\` looks similar to \`${f.match}\` (${f.matchWhere}, \`${f.matchFile}\`).

Similarity ${f.score} on name and description; shared terms: ${f.shared.map((w) => `\`${w}\``).join(', ')}.

**Suggestion:** ${f.suggestion}

Reply with what you decided (combined it, built on it, or why it's deliberately different), then **resolve this conversation**. GitHub doesn't re-run checks when a conversation is resolved, so after resolving the last one, add a comment (in this conversation or on the pull request) or re-run the check, and it turns green. The pull request can't be merged while this is open.

<!-- ${MARKER}${f.key} -->`;

async function main() {
  const findings = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const summary = (s) => { console.log(s); if (SUMMARY) appendFileSync(SUMMARY, s + '\n'); };

  const threads = await duplicateThreads(owner, name, PR);
  const known = new Set(threads.map((t) => t.key));
  const fresh = findings.filter((f) => !known.has(f.key) && known.add(f.key));
  for (const f of fresh) {
    await gh(`/repos/${REPO}/pulls/${PR}/comments`, { method: 'POST', body: { body: comment(f), commit_id: SHA, path: f.file, subject_type: 'file' } });
    summary(`- New comment: \`${f.skill}\` ~ \`${f.match}\` (${f.score})`);
  }

  const open = threads.filter((t) => !t.resolved).length + fresh.length;
  const reviews = (await gh(`/repos/${REPO}/pulls/${PR}/reviews?per_page=100`)).filter((r) => r.user?.login === BOT);
  const blocking = reviews.filter((r) => r.state === 'CHANGES_REQUESTED');

  if (open) {
    if (fresh.length || !blocking.length) {
      await gh(`/repos/${REPO}/pulls/${PR}/reviews`, { method: 'POST', body: { commit_id: SHA, event: 'REQUEST_CHANGES',
        body: `**Duplicate check:** ${open} comment(s) about possible repeats of existing skills are open. Reply to each with the decision and resolve it, then add a comment (in the conversation or on the pull request) or re-run the check; it passes once all are resolved.` } });
    }
    summary(`**${open} duplicate comment(s) open.** Reply to each and resolve it; this check passes once all are resolved.`);
    process.exit(1);
  }
  for (const r of blocking) {
    await gh(`/repos/${REPO}/pulls/${PR}/reviews/${r.id}/dismissals`, { method: 'PUT', body: { message: 'All duplicate comments are resolved.', event: 'DISMISS' } });
  }
  summary(threads.length ? `All ${threads.length} duplicate comment(s) are resolved.` : 'No likely repeats of existing skills.');
}

// Run as a command (not imported)? Compare real paths: the script may be started through a symlinked path,
// such as macOS's /var → /private/var or a symlinked home folder, and then the plain paths differ.
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main().catch((e) => { console.error(`duplicate-review: ${e.message}`); process.exit(2); });
}
