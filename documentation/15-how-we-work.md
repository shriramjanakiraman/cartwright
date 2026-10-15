# How we work: the AI development team

Cartwright is built by a small team of AI agents working for a human **team lead**, using an agentic
development lifecycle (ADLC). Each agent has one role, hands its work to the next through written artifacts,
and asks the team lead whenever something isn't clear. Nobody guesses.

```
            team lead (you): requirements, approvals, questions, final say
                 │                         ▲  questions, approvals, discrepancies (verbatim)
                 ▼                         │
            coordinator (the main agent session): routes work, relays, keeps the thread
       ┌─────────────┬──────────────┬──────────────┬──────────────┐
       ▼             ▼              ▼              ▼              │
  business       architect      developer        tester           │
  analyst                                                         │
  brief + AC ──▶ design + ADR ──▶ branch + PR ──▶ test report ──▶ architect review ──▶ team lead
```

## Roles

| Role | Agent | Owns | Never does |
|---|---|---|---|
| **Team lead** | you | what we build and why; every approval; the final call | — |
| **Coordinator** | the main session | routing work between roles, relaying questions and answers word for word, keeping one thread per piece of work | decide on the team lead's behalf |
| **Business analyst** | `.claude/agents/ba.md` | turning a request into a requirement brief with testable acceptance criteria; the GitHub issue | design solutions or invent requirements |
| **Architect** | `.claude/agents/architect.md` | the design, the branch type and test level, decision records (ADRs), reviewing every pull request against the design and our engineering principles | write the feature itself |
| **Developer** | `.claude/agents/developer.md` | implementing the approved design on its branch, with tests, docs and the CHANGELOG line; the pull request | change the design or scope without asking |
| **Tester** | `.claude/agents/tester.md` | proving the acceptance criteria, running the test framework at the right level, investigating every failure, the verdict | weaken a check to get a pass |

Each agent file is plain Markdown, so Codex, Copilot and other agents can take on a role by reading it.

## The flow for a feature or a bug

1. **Intake (business analyst).** The team lead says what they want, however roughly. The analyst reads the
   repo and the decision records, then asks the team lead what it can't infer: at most three questions at a
   time, in plain text. It writes a **requirement brief** (`documentation/templates/requirement-brief.md`):
   problem, who it's for, acceptance criteria (Given / When / Then), out of scope, risks, open questions.
   - **Gate 1: the team lead approves the brief.** Then the analyst files it as a GitHub issue.
2. **Design (architect).** Reads the brief, the code and the existing decisions. Proposes the design with the
   options it considered, the branch type (feature, bugfix, hotfix), the test level, and what could break.
   A significant or hard-to-reverse decision becomes an ADR in `documentation/decisions/`.
   - **Gate 2: the team lead approves the design** when it's significant: a new dependency, a change to how
     users install or use Cartwright, anything breaking, security or client privacy, cost, or a choice
     between real alternatives. Small, obvious designs go straight on, and the coordinator says so.
3. **Build (developer).** Branches per `AGENTS.md`, implements exactly the approved design, adds or updates
   tests (a new behaviour gets a test in the framework), docs and the CHANGELOG line, runs
   `npm run build && npm run check` and the quick test, and opens the pull request. If the design turns out
   not to fit, it stops and goes back to the architect and team lead; it doesn't improvise.
4. **Test (tester).** Maps each acceptance criterion to evidence, runs the framework at the architect's
   level, investigates every failure (product bug, test problem, agent flakiness, environment) and writes the
   verdict into the pull request.
5. **Review (architect).** Reviews the pull request against the design and the principles below; anything
   that drifted goes back to the developer.
6. **Done: the team lead decides.** Merge, change, or drop. Only the team lead approves merges and releases
   (or explicitly delegates one).

A **bug** runs the same flow, lighter: the brief is the bug report (what happens, what should happen, how to
reproduce), and the tester first reproduces it so the fix can be proven.

**Releases:** the weekly release cuts itself; otherwise the team lead asks. The architect confirms the version
from the CHANGELOG (a major only with the team lead's yes), the tester runs the matching level, and the team
lead merges. A **hotfix** needs the team lead's yes before anything starts.

## Asking instead of guessing

Every agent stops and asks the team lead, through the coordinator, when:

- a requirement is ambiguous, missing or contradicts another one
- the work conflicts with an existing decision record, `AGENTS.md` or `GOVERNANCE.md`
- there's a risk the team lead should know about: breaking change, security, client data, cost, time
- something outward-facing or hard to undo is next: pushing outside a branch, merging, releasing, creating
  or deleting repositories, posting to an external service
- the facts can't be checked (an API's behaviour, a tool's version): then the agent says what it couldn't
  verify instead of assuming

Questions go to the team lead **verbatim**, in plain text, with what the agent already knows and its
recommendation. The answer is recorded where it belongs: in the brief, the ADR or the pull request.

## When the team lead asks or challenges

Anyone may be asked "why did we do X?" or told "I don't agree". The answer comes from the record (the
brief, the ADR, the pull request, the test report), quoted or linked, not from memory. If there's no record,
say so plainly. If the challenge changes a decision, the architect writes a new ADR that **supersedes** the
old one; nothing is silently rewritten.

## Engineering principles (the architect holds the line)

1. **Simple first.** The smallest design that meets the acceptance criteria; no speculative features (YAGNI).
2. **One source of truth.** Generated files are never edited by hand; rules live in one place and other
   places link to it.
3. **Agent- and machine-agnostic.** Works in Claude Code, Codex, Copilot and others; no local paths or
   one-person setups.
4. **Privacy by design.** No client data in core, ever; secrets never anywhere; least privilege for tokens.
5. **Backwards compatibility and semver.** Users' install commands and skills keep working; anything that
   breaks them is a major release and the team lead's call.
6. **Testable.** Every behaviour change comes with a test in the framework; a bug fix comes with a test that
   would have caught it.
7. **Fail clearly.** Clear errors that say what to do; never fail silently or exit successfully after doing
   nothing.
8. **Idempotent and reversible.** Scripts are safe to re-run; risky steps are confirmed and can be undone.
9. **Docs as code.** The guide changes in the same pull request as the behaviour.
10. **Pin and verify dependencies.** Versions are pinned and smoke-tested before anyone gets them.

## Artifacts and traceability

| Artifact | Where | Written by |
|---|---|---|
| Requirement brief | GitHub issue (from `documentation/templates/requirement-brief.md`) | business analyst |
| Decision record | `documentation/decisions/NNNN-title.md` | architect |
| Branch and pull request | per `AGENTS.md`; the PR links the issue and any ADR | developer |
| Test report | `npm run test:release` output in the pull request | tester |
| Release notes | `CHANGELOG.md` | developer (lines), architect (version) |

Issue → brief → ADR → branch → pull request → test report → release: every step links to the one before.
