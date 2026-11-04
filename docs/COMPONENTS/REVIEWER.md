# Reviewer

An agent: reviews the fix, or the improvement, once the gates pass. Part of the [factory plane](README.md#agents).

- **Reads:** the ticket's public view and what the senses saw, or Martin's request, Martin's answers at Plan (for holding the spec to what he asked), the pull request's diff, the spec, and the app's `docs/REVIEWERS.md` at the base.
- **Produces:** a comment review, a check run, and its findings.
- **v1:** `line/agents/reviewer.ts`, in a [runner](AGENT-RUNNERS.md) at the pull request's head with its base beside it, with 30 turns and 15 minutes.

## What it holds the change to

- **The rules as they are at the base,** so a change cannot loosen them.
- **The diff,** against the coder's claims.
- **The spec, against the ticket,** with Martin's answers as part of the ticket (his own words; what the line reads into an approval is told as the line's), as well as the diff against the spec. Each criterion comes with the words the planner quoted for it, which the line found where it said; the reviewer judges whether they ask for it. The diff is held to the spec alone, since the coder reads the spec and never his answers: what his answer asks for that no criterion carries (a test's name to keep, which no page shows) is the spec's fault, never the change's, however the change went against his words, and goes to him as a criterion beyond the ticket does; never a round on the coder for words the spec never carried.
- **The tests the spec contradicts,** which the change may delete, rename or rewrite and no other, each by its file and full name, quoted as data. Each is held to the ticket as a criterion is: a test no criterion the ticket asks for needs changed is a contradiction the ticket does not ask for, blocking and citing the criterion said to contradict it and the ticket; a named test changed further than its criteria need blocks too, and goes back to the coder.

| It finds | Finding | Goes to |
|---|---|---|
| A criterion the ticket and Martin's answers do not ask for; or an ask in his answer that no criterion carries, which the change went against | Blocking, citing that criterion (for a lack, the one the change was meeting) and the ticket. The schema makes such a review an escalation, in every autonomy mode, since the coder cannot put a spec right | Martin, as `beyond-ticket` |
| A change that goes beyond a sound spec | Blocking, citing the spec or a rule | The coder |

An improvement's spec is held to Martin's request and his answers in the same way: a criterion he did not ask for blocks, cites the request (the finding's `ticket`), and goes to him. Its change is held to its flag too, and each of these blocks and goes back to the coder:

- anything a visitor or a caller could see change with the flag off, since the change ships off;
- a criterion that no test shows on its side of the flag;
- the flag read any way but `await request.flag('<flag>')`, or another flag read;
- anything kept on a visitor's device;
- a change to the app's flag context, `src/flags/`.

## Its result

Read with Zod:

- **a verdict:** approved, changes requested, or escalated to Martin;
- **a note;**
- **up to 20 findings,** each anchored to a line, blocking or not, citing a rule's number, a criterion of the spec or the ticket, in at most 300 characters. In a later review, a finding that gives one of the review before again, in its words or new, names it (`holds`).
- **in a later review, what is answered:** the numbers of the findings of the review before that the change now answers: one it blocked on put right, or a suggestion taken. One it still holds is left out, and given again as a finding of this review.

A later review is told what the review before blocked on, then what it suggested, numbered after those, and apart from them the suggestions the coder declined, with its reasons.

## What the line does with it

The line posts it through the [GitHub worker](GITHUB-WORKER.md) (`line/review.ts`), each once for a handback:

1. the check run `factory review`, which no ruleset requires: a signal, never a gate;
2. a comment review, with a finding the diff does not show in its body;
3. in a later review, a reply on the thread of each earlier finding it finds answered, naming the commit reviewed (`Answered in`, or `Taken in` for a suggestion), and the thread resolved. So is the thread of every finding before it that it held again, back to the first: a finding given again in new words has a thread of its own. The app's `main` merges nothing with a review thread open, so a finding put right no longer waits for Martin to resolve it by hand. A thread is found by its first comment, the App's, as the review wrote it, on the line it was made on; one the review gives again word for word stays open. GitHub refusing to resolve one does not hold the work item: Martin resolves it by hand.

Each is done in that order, so GitHub failing part way through never runs the reviewer again, and tries only what is left.

- **Blocking findings** go back to the coder's session, with the suggestions.
- **An approval's suggestions** go back to the coder once in a pass, to take or decline, before the describer writes the change up ([the line](ORCHESTRATOR.md#build-gates-and-review)). The suggestions of an approval after that, or of one Martin gave, stay for him to resolve, and the review's body says so.
- **After two reviews**, or the round for an approval's suggestions, what still blocks holds for Martin, as does an escalation. His answer sends the work round again, his approval stands in for the reviewer's, and rejecting closes it ([holds](ORCHESTRATOR.md#holds-and-martins-answers)).

## Counting the rules

`factory reviews rules` counts findings by rule from the event store, so a rule never cited can go, and one cited often can become a lint rule or move into `AGENTS.md`.
