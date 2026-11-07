# Planner

An agent: writes a spec for each ticket the line takes, unless its sense finds the defect already gone as the line takes it ([open tickets a release may have fixed](RELEASE-AND-VERIFY.md#open-tickets-a-release-may-have-fixed)), and for each improvement Martin asks for. Part of the [factory plane](README.md#agents).

- **Reads:** tickets; Martin's improvement requests.
- **Produces:** a spec per work item: outcome, acceptance criteria, scope, the existing tests the criteria contradict, risk, rollout; and for an improvement, its title, its flag and its pages.
- **v1:** `line/agents/planner.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from, with 30 turns and 15 minutes: main's head, or, planned again once the work item has a pull request, where that pull request's branch left main, which the change's tests are judged against (below).

## Its prompt

- **The ticket's public view**, and each sense's signal by its typed fields (`line/agents/evidence.ts`): one for each version of the app a sense saw the problem in, so every version rolled back on it.
- **Never a report, and no log message,** since an app may log what a visitor typed, quoted or not. A log signal is told by its route, its requests and its lines at each level, and every route is cut at its query.
- **On a fresh pass after Verify,** each time a released fix's signal persisted, and each time the ticket reopened after a fix that shipped, so it finds out why the last fix did not hold before it plans another.
- **Martin's answers** to its earlier questions and rejections, with what he was asked, and to the holds that send the work back to it: what he was asked by a `scope` hold says what the fence printed or which files the coder needs and why (the coder's words), and approving it asks it to take them into the scope, never a protected path ([holds](ORCHESTRATOR.md#holds-and-martins-answers)). Only his own words are his answer. What the line reads into one (an approval with no words lets the scope take the files in; a file no scope may name stays out) is told as the line's, beside them or in their place, and neither it nor the coder's words is a source a criterion may quote. Everything his answer asks for goes into the spec, as a criterion from his answer that quotes his words, a constraint on the change itself (a test's name to keep) as much as a behaviour a page shows: the coder reads the spec and never his answers, and is held to nothing the spec does not say.

### Planned again

Work comes back to Plan when Martin answers a hold that sends it there (`scope`, `beyond-ticket`, `nothing-to-fix`, `spec` or `verify`), or sends one back to it in words where they would otherwise go to the coder (`gates`, `review`, `merge` or `tests-first`), when a released fix's signal persists, or when the ticket reopens. The planner is then told:

- **That it is a replan,** with its last spec as it wrote it, as JSON, so a criterion it keeps keeps its `from` and its `quote` word for word.
- **Why it came back,** in plain words, by cause: the files the coder needs, each with why, and whether Martin approved or answered in words; what the fence printed; the reviewer's findings that cite the ticket, each beyond it or short of his answer (a lack only where his words can be read: never on a work item a visitor's report opened); the coder's reason for finding nothing to fix; his answer to the spec, or at Verify; or, sent back from a hold after the coder's work, why it was held, that he judges the spec is what must change, and to name in `contradicts` any existing test a criterion means must change; and, wherever he answered in words, that everything his answer asks for is carried into the spec as criteria that quote his words, since the coder is told nothing of his answer.
- **To keep what still holds,** and change only what the return asks for: on a return for the scope, usually the scope alone.
- **The pull request,** when the work item has one: its number, and the files it changes, which are this work item's own work so far. Its checkout is not that work but where the pull request's branch left main, as its first plan's was, so a criterion still fails at the commit it plans against, and nothing already built reads as another change's. The coder's next round starts from the pull request's head, as any later round does.
- **For an improvement, its flag,** which stays: Martin's moves, the baseline and the pictures are all recorded against it. The schema refuses a spec that names another.

For an improvement, instead of a ticket and its signals:

- **Martin's words,** through the redactor, as the [request](ORCHESTRATOR.md#an-improvement) has them, and the title made from them.
- **Where the change goes, not a diagnosis.** Nothing is broken: it reads the code that serves the pages the change shows on, and builds and tries nothing, since the coder builds it test first.
- **How it ships:** behind a flag of its own, which the app reads with `await request.flag('<name>')`, off until Martin turns it on ([feature flags](FEATURE-FLAGS.md)).
- **The flags taken:** every flag another improvement Martin asked for has named, open or closed, since a closed one's code stays in the app behind its flag.

## Its result

A spec, a rejection or a question, read with Zod, each with up to five `findings`; on a ticket a visitor's report opened, a spec or a rejection alone ([below](#a-rejection-or-a-question)). A result the schema refuses fails the step, and the next attempt is told why. A finding is an extra for triage, so one that does not fit never costs the result: it is left out, logged once for its handback, and counted in the spec's summary.

### A spec

- **Criteria.** Each criterion names what in the ticket's evidence asks for it (`from`: the ticket, a numbered signal, or Martin's answer), and quotes the words there that do (`quote`). The schema refuses a spec whose quote is not in what its criterion names, as the prompt told it, before any review; whether the words ask for the criterion is the [reviewer's](REVIEWER.md) to judge. One nothing asks for does not belong in the spec. A constraint in Martin's answer on the change itself, such as a test's name to keep, is a criterion that quotes it, shown by the test or file it names kept or rewritten as he asked, since the coder is told nothing of his answers.
- **Scope.** A plain path in the repository. It never names `.github/`, `deploy/` or a path the app's CODEOWNERS gives Martin at that commit, which the line reads through the [GitHub worker](GITHUB-WORKER.md).
- **Tests it contradicts.** An existing test a criterion makes wrong (a criterion that every asset may be cached contradicts a test that the stylesheet is never kept) is named in `contradicts`, by its file and its full name, its `describe` names and its own joined with " > ", as [test integrity](TEST-INTEGRITY.md#tests-the-spec-contradicts) names it; usually there are none, and an empty list is read as none. They are the only tests the change may delete, rename or rewrite. The planner names them, not the coder, so the coder cannot excuse itself. The schema holds each to what the gate would read (its own `entryProblem`, which also refuses a marker, an @mention or an issue's number, since the App writes the name into the description), at most ten, in a file the gate compares as a test file (`TEST_FILE`) that the scope takes in and no protected path, each once; and the line refuses a spec that names a test its file does not have at the commit, reading the file through the GitHub worker, as it refuses a quote that is not there. A file it cannot read as text is left to the gate, whose summary says an entry names no test. The line writes them into the pull request's description ([the GitHub worker](GITHUB-WORKER.md#descriptions)), and the console's sheet shows them under the criteria.
- **Risk.** A spec tagged `out-of-scope` holds for Martin before the coder starts ([approval routing](APPROVAL-ROUTING.md)). A spec that names a test it contradicts carries `test-loosening`, which the line adds if the planner left it out: an agent may add a tag, never take one away. It holds nothing before code.

### An improvement's spec

It has the fields a fix's has, and the schema refuses one without these:

- **`title`:** what the work item is, in a few words; it names the work item from then on, in place of the one made from Martin's first sentence.
- **`flag`:** a flag's name as the app names them, lower-case words joined by hyphens: never `flag-set-revision`, and none another improvement has named; planned again, the one its last spec named.
- **`pages`:** one to six pages a visitor opens to see the change, by their paths, which Verify pictures with the flag off and on.
- **`withFlag` on each criterion:** the side of the flag it holds on, with at least one on each: `on` for what the change does, and `off` for the app as it is now, which is what keeps the change from reaching anyone until Martin turns the flag on.
- **Each criterion from what Martin asked:** `from` names the request or his answer, and the quote is there; an ask in his answer about the change itself is a criterion too.

A risk tagged `out-of-scope` means beyond what Martin asked. Every improvement's spec is held for his approval before any code ([an improvement](ORCHESTRATOR.md#an-improvement)).

### A rejection or a question

It rejects what it cannot make testable, or what only a protected path would fix, and asks Martin what only he can say. It rejects an improvement that needs a protected path, the app's flag context (`src/flags/`) among them, or that would keep anything on a visitor's device, such as a cookie or anything in the browser's storage: what may be kept there is decided in this repository, which the line cannot write. Both hold the work item ([holds](ORCHESTRATOR.md#holds-and-martins-answers)):

- his answer to either reaches every later plan, with what he was asked;
- rejecting closes the work item, and so does approving the planner's rejection.

Once Martin approves its question with no answer, on any work item, the planner plans again told that none will come, and is offered no question until it writes a spec, and its schema takes none (`unanswered`, as the line reads it): it would only ask the same again. It decides from the evidence it has, and where the fix would turn on what only he can say, it rejects the ticket, saying what he would have to decide; an improvement takes the plainer reading of what he asked. A question handed back then does not fit the schema, and fails the step like any other. On a ticket a visitor's report opened (its first signal is a report), Martin's words reach it only where he shares them, as their author ([holds](ORCHESTRATOR.md#holds-and-martins-answers)), which is what lets it ask there: unshared, he approves its question or rejects it.

### Findings

Anything else it notices is a finding: a page, its route and a sentence.

- The page and the route are paths without a query: one that names a query is cut at it, not refused, and a query the defect needs is in the sentence. A finding that is not a path, has a field too long, or comes past the fifth is left out, and the rest of the result stands.
- The line leaves it in triage's inbox as a signal from the planner, naming the work item it was planning, once for the work item however often it plans ([triage](TRIAGE.md#the-planners-findings)).
- Its words are kept from every public view and every agent, as a report's are.
