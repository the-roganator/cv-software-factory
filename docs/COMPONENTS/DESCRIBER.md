# Describer

An agent: describes the fix, or the improvement, once review approves it. Part of the [factory plane](README.md#agents).

- **Reads:** the ticket's public view and what the senses saw, or Martin's request, the spec with the tests it contradicts, the final diff and the coder's commit messages, and the review thread, round by round.
- **Produces:** the pull request's title and description, and the work item's summary (`work-item.summarised`).
- **v1:** `line/agents/describer.ts`, in a [runner](AGENT-RUNNERS.md) at the pull request's head with its base beside it, with a fresh context, 30 turns and 15 minutes.

## Its skill

It names the runner's `visual-pr` skill (vendored from HumanLayer under MIT, `apps/runner/plugin`), which:

- fits a description to its change: a line, if a line will do, and a few points for a small change;
- lays it out to scan: the opening sentence alone, then one point to a bullet;
- folds what supports the story, such as the tests and the rollout, into `<details>` sections with a `##` heading in each summary;
- reads the repository's pull request template as questions to answer, not headings to fill.

Martin's own `/visual-pr` follows the same skill, so the line's descriptions are written to his rules.

## Its result

Read with Zod:

- **the description,** written as a Markdown file beside its result;
- **the title,** a Conventional Commit of 80 characters at most, of type `feat` for an improvement;
- **the summary:** a title, two lines for the card, and the paragraph at the top of the sheet. It says what happened, never where the work item stands, since nothing writes it again as the work item moves on: the console says where it stands, and ends the story once it closes.

The squash commit takes the description as its message, so the schema refuses:

- a closing keyword before an issue, which would close the ticket's issue on merge rather than once the fix is verified, or an improvement's, which stays open while Martin turns its flag on;
- an @mention outside code;
- a `factory:contradicts` marker, since the line writes the section test integrity reads;
- a folded section that would not render, read line by line (`line/agents/folds.ts`): GitHub shows the Markdown in a `<details>` as text unless a blank line ends the HTML before it.

A refused result runs the step again, told why.

A description names among its risks each test the spec contradicts, with what the change did to it and which criterion asked for that. It writes no section for them: the line adds the one [test integrity](TEST-INTEGRITY.md#tests-the-spec-contradicts) reads.

An improvement's description says what Martin asked for, what the change adds behind which flag and on which pages, which test shows each criterion and on which side of the flag, and that it ships off: nobody sees it until Martin turns the flag on. Its pull request waits for his merge in every autonomy mode.

## What the line does with it

1. It sets the pull request's title and description, with the line that refers to the ticket's issue and, after the describer's words, the section that names the tests the spec contradicts, which the GitHub worker writes ([descriptions](GITHUB-WORKER.md#descriptions)), then takes it out of draft, each once for a handback. The merge queue's run of test integrity reads the section there.
2. It appends the summary.

Then the line adds the pull request to the merge queue, where Martin's settings and the review gate allow, or holds it for Martin's merge ([the merge](ORCHESTRATOR.md#the-merge)). If the work goes back to Build while it waits, the line puts the pull request back to draft, and the describer writes up the next round before it is merged.
