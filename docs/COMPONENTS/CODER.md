# Coder

An agent: writes the fix, or builds an improvement behind its flag. Part of the [factory plane](README.md#agents).

- **Reads:** the planner's spec, the ticket's evidence or Martin's request, the repository and its `AGENTS.md`.
- **Produces:** a failing test, the fix, and a patch with a title and a note.
- **v1:** `line/agents/coder.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from (the pull request's head in a later round), with 50 turns and 30 minutes.

## Its prompt

- The ticket's public view, and each sense's signal by its typed fields, as the [planner's](PLANNER.md#its-prompt) does (`line/agents/evidence.ts`).
- The spec, with its scope as the only files it may change. Never Martin's answers: what they ask for reaches it through the spec alone, as criteria that quote his words ([planner](PLANNER.md#its-prompt)), and it is held to nothing the spec does not say.
- In a later round sent back by review, the review's blocking findings and its suggestions, numbered.
- In a later round sent back by the gates, each required check that failed, with what it said was wrong at which file: its annotations at the failure level, which the line records with it (`gate.finished`), without Actions' line for a step that exited non-zero. They are the gate's words, which quote the app's code (a test's name, a path), so each is redacted as a public view is, and quoted on a line of its own, cut to the 300 characters the event keeps, under a line that says it is data. A check with no reason recorded is still named.
- Before its first round, the rule the [test integrity](TEST-INTEGRITY.md) gate holds it to: tests may be added, but no existing test deleted, renamed or skipped, and none of its assertions changed or taken out, unless the pull request's description names the test as one the spec contradicts.
- When the spec names tests its criteria contradict, those tests, each by its file and full name, quoted as data as a gate's annotations are: it may delete, rename or rewrite exactly those to match the criteria, and no other, and skips none of them. It never writes the description, where the line names them for the gate, so it cannot excuse a test itself. A test the criteria contradict that the spec does not name it leaves as it is, and says which in its note: the gate fails the round, and Martin decides. A later round that resumes its session is told the tests again, since the spec may have been written afresh.
- When a criterion cannot be met without changing a file outside the scope (an existing test its change rightly makes wrong), to leave that file alone and name it, with why: never a path no scope may name, which the prompt lists. A later round that resumes its session is told it again.

For an improvement, Martin's words in place of the ticket, and the spec with its flag, its pages and each criterion's side of the flag, and:

- **Every new behaviour behind the flag,** read as `await request.flag('<flag>')`, as the app's `AGENTS.md` says, and nowhere else, so that with it off the app is as it was.
- **The flag defined nowhere:** one the flag service does not name is off, so the change ships off.
- **Each criterion's test with the flag as its side says,** stubbing the request's `flag` as the app's own tests do (`flag: async () => false`, or true for the flag named).
- **Never the flag context, `src/flags/`,** and nothing kept on a visitor's device.

It writes the test first, and leaves alone what else it notices. Before it hands back, it runs what the app's CI requires of a change, lint and formatting, the type check and the tests, by the commands the app's `make check` runs, since the runner has no `make`, and leaves out the manifests, which it has no renderer for, saying in its note what it left out. It puts right only what its change caused, and a file the formatter refuses by the formatter alone, so a lint fix does not widen the patch. A change the gates would refuse for its formatting or a type error does not cost a round. A later round that resumes its session and changes something is reminded to run them again.

## Its result

Read with Zod, one of:

- **a change:** a Conventional Commit title, of type `fix`, `test`, `refactor` or `perf` for a fix and `feat` for an improvement, and the commit's note, with the suggestions it declined;
- **no change,** when the change needs none: why it changed nothing, in at most 200 characters ([when a step fails](ORCHESTRATOR.md#when-a-step-fails)), declining every suggestion it was given, so no thread outlives Martin's answer;
- **every suggestion declined,** in a round sent back for an approval's suggestions alone: nothing changed, and the approval stands. A change's title and note that come with every suggestion declined and no patch are taken the same way;
- **the files it needs outside the scope** (`needs`), alone or beside a change or no change: each a plain path, with why in at most 200 characters, twenty at most. The line holds the work item as `scope` at once and pushes nothing of the round ([holds](ORCHESTRATOR.md#holds-and-martins-answers)); Martin's approval sends them to the planner, which may widen the scope to them. A file the scope already takes in is not one it needs: a result that names only those has failed, with a change or without, since a change without the file is not the one it said it needed. The suggestions it declined in that round are answered with its reasons before the hold, and recorded (`suggestions.answered`), and its session is not kept, since it holds work that was never pushed.

A step that hands back no change and does not say why has failed.

## Suggestions

The coder answers the reviewer's suggestions as the factory asks of any agent answering a review: it takes each, changing the code for it, or declines it with a reason (`declined`: its number and why, in at most 300 characters). Each suggestion is answered once.

- **One declined** has its thread answered with the coder's reason and resolved by the [GitHub worker](GITHUB-WORKER.md), once the round is pushed. The next reviewer is told it, with the reason, and gives it again only if the reason does not hold.
- **One taken** is the next reviewer's to find taken; its thread is resolved then ([reviewer](REVIEWER.md#what-the-line-does-with-it)).

The line records the answer as `suggestions.answered`.

## Its fences

- The line fences its patch to the spec's scope before anything reaches GitHub. Naming a file it needs widens nothing: only the planner's next spec, which Martin has approved sending back to it, can.
- It cannot sign, merge or touch workflows.
