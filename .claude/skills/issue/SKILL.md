---
name: issue
description: Draft and file a GitHub issue for Software Factory to the project's standard — a title that states the problem, one line that says what is wrong, and only as much more as it needs.
argument-hint: "[what's wrong, in your own words]"
---

# Filing an issue

Issues are public and part of the portfolio. A reader judges the project by them, so each one is held to the bar in `docs/INTENT.md`: clear, honest and no longer than it needs to be. There is no template. A one-line issue is complete when one line says it.

## The standard

**The title states the problem.** A plain statement of what is wrong or missing, as someone who saw it would say it. Sentence case, no full stop, under about 70 characters.

- Good: `A restarted gateway misreads a provider cap as its own`, `Closing a work item leaves its pull request open`, `The planner can widen a ticket, and nothing catches it`.
- Not: `Fix spend resume bug` (an instruction, not a problem), `[Bug] Gateway issue` (a label and no information), `Investigate caching` (an activity), `Spend caps` (a topic).

An idea is stated as what is missing: `Nothing reads what the line learns`, not `Add a steward`. The solution can come in the body.

**The first line of the body says what is wrong, and for whom or when.** One sentence that adds to the title rather than repeating it. If the issue stopped here, someone could still act on it.

**Everything after that is optional,** and earns its place:

- **Evidence**, when there is some: what was seen, where, with a permalink to the code at a commit (`https://github.com/the-roganator/cv-software-factory/blob/<sha>/path#L10-L20`), a work item number, a log line, a figure. Trim logs to the lines that matter; put anything long in `<details>`.
- **Why it matters**, if that is not obvious from the first line.
- **What might fix it**, not a plan. Where there is a real choice, the candidates, and which one you would pick if you would. Where the fix has parts that all need doing, they are its scope: say so, and list them as such, not as candidates.
- **When it matters**: the milestone or the trigger it waits for ("before the Agent SDK is next updated", "when a soak shows it"). This is what lets an issue wait without being forgotten.

Headings only when an issue is long enough to need finding your way around. No checklists of fields, no "Steps to reproduce" for something that has none, no "Expected / Actual" when one sentence says both.

## The voice

The repository's own (`AGENTS.md`, `docs/TERMS.md`):

- British English. Short, plain sentences in the present tense. Say what is, not what "should probably" be.
- The project's words: work item, the line, stage, sense, runner, handback, gate, console, as `docs/TERMS.md` defines them. In this repository an issue is the GitHub record, a defect is something wrong with the app, and a ticket is a defect triage has recognised; `bug` is only a label.
- Martin writes as himself: "I saw" is fine for an observation. The system is described as it is, not as "we" feel about it.
- Name what was measured with its number. Say plainly what was not checked ("not measured", "not verified").
- No hype, no apology, no emoji, no "TODO", no "quick win", no "simply".

## What never goes in an issue

Both repositories are public, and the app's defects are seeded on purpose.

- **Nothing that names or hints at a seeded defect**: no route, symptom or file tied to one, unless the factory has already made it public in its own issue. Never anything from the private repository or the answer key. Defects in the app are for the factory's senses to find, not for an issue to point at.
- No visitor's report text, API keys, tokens, cassette contents, or prompts and tool output from real runs.
- Nothing from `scratch/`, the handover or a session transcript pasted wholesale.

When in doubt, leave it out and say so to Martin.

## Where it goes

- **`the-roganator/cv-software-factory`**, by default: the factory, the console, the docs, delivery.
- **`the-roganator/cv-worlds-worst-website`** only for the app's repository itself (its CI, its README, its deploy), never for a defect in the app. Issues there may be read by the factory, which acts only on its own issues and those Martin labels for it.

## Labels

One type label, from the ones that exist: `bug` (something does not work as described), `enhancement` (something missing or worth improving), `documentation`, `question`. Add `accessibility` where it applies. Do not invent labels.

## Milestones

The GitHub milestones are the plan's: `Milestone 6: Shipping safely` is milestone 6 in `docs/PLAN/README.md`, and its number in GitHub is 6 too. Set the one an issue waits for (`--milestone "Milestone 6: Shipping safely"`). An issue that waits for a trigger rather than a milestone ("before the Agent SDK is next updated") has none, and says when it matters in its body. A milestone added to the plan gets its GitHub milestone in the same change: `gh api repos/the-roganator/cv-software-factory/milestones -f title="Milestone 12: …" -f description="<its outcome>"`.

## How to file one

1. **Work out the issue** from the arguments, the conversation, or what was just found. If what is wrong is unclear, ask one question; don't guess.
2. **Look for a duplicate**: `gh issue list -R <repo> --state all --search "<key words>"`. If one exists, offer a comment on it instead.
3. **Check the facts** you cite: open the file, find the line, get the commit for a permalink (`git rev-parse origin/main`). An issue that misquotes the code costs more than no issue.
4. **Check the words**: read `docs/TERMS.md` and check every word of the title and body against its "Not" column, so the issue says work item rather than job, step rather than attempt, gate rather than check where it means a gate. A word the file rules out is replaced, not explained.
5. **Show Martin the draft**: the repository, the title, the label, the milestone, and the body exactly as it will appear. Filing is public and outward-facing, so wait for his yes. If he has already said "file it", one look at the draft is still owed for anything longer than a few lines.
6. **File it** with the body from a file, so nothing is mangled by the shell:
   ```sh
   gh issue create -R the-roganator/cv-software-factory --title "<title>" --label <label> [--milestone "<milestone>"] --body-file <scratch file> [--attach <image>]
   ```
   Write the body file in the session's scratchpad, not the repository. `--attach` uploads a screenshot or video. Reference it in the body by the same path (`![<alt text>](./scratch/screenshots/x.png)`) to place it where it belongs; `gh` rewrites the reference to the uploaded file. Otherwise it is added at the end. Give every image alt text that says what it shows.
7. **Give back the link**, and nothing else to report.

## Examples

A complete issue:

> **Two console tests are flaky**
>
> `e2e/visual.spec.ts` (the phone snapshot of a card with every page) and two drag tests in `e2e/reel.spec.ts` fail now and then in CI on changes that leave the console alone, and pass when run again.

A longer one, because it needs the evidence:

> **The planner can widen a ticket, and nothing catches it**
>
> A spec's criteria can ask for behaviour the ticket never reported, and the coder and reviewer follow the spec rather than the ticket.
>
> Seen in a dry-run soak on Qwen: the spec added a criterion that nothing in the ticket's evidence asked for. The coder rewrote more of the code to meet it, and the reviewer approved because the spec asked. Every file was in scope, so the scope fence passed it.
>
> Two candidates, which could go together: each criterion must trace to the ticket's evidence; the reviewer checks the spec against the ticket as well as the diff against the spec.
>
> Matters before the line runs without Martin reading each spec.
