# Test integrity

Stops agents weakening tests to get green. Part of the [GitHub plane](README.md#github-plane).

- **v1:** two gates on the app's pull requests ([shared gates](SHARED-GATES.md)).
- **Later:** mutation score on changed code (Stryker); acceptance criteria without a tagged test.

## Test integrity

It reads each test file of the base and the change (`gates/tests.ts`: Vitest's and Jest's `describe`, `it` and `test`, with their modifiers), and fails:

- a deleted test file or test;
- a test newly skipped, left to do, or narrowed with `.only`;
- a test that loses any `expect` or `assert` call it made. Each call is kept as text, the whole chain (`expect(res.status).not.toBe(500)`), with spacing, line breaks and comments between code and a trailing comma taken out, and every plain string in single quotes, so a test reformatted still asserts what it did. A call changed is one lost: keeping a test's name and turning its expectation around (`toBe('no-store')` to `toMatch(/max-age/)`) fails, as it is the weakening the gate exists to stop, and leaves a test named for what it no longer checks. Assertions added pass, and a call made twice must still be made twice.

A test that moved file under its name has moved, not been deleted. Two tests of one name in a file are each matched with their own: first with one left exactly as it was, wherever it now is, then in order. So reordering them changes nothing, and deleting one of them fails as a deletion, where once the one left counted for both.

Each failure is an annotation on its file, such as `"a product page > says when it was last dusted" was deleted` or `"files > keeps nothing of the other files" no longer asserts expect(headers('/site.css').get('cache-control')).toBe('no-store')`. When the gate sends a change back, the line gives the [coder](CODER.md#its-prompt) these words, and the coder is told the rule before its first round.

### Tests the spec contradicts

A change's spec can contradict an existing test: a criterion that every asset may be cached contradicts a test that the stylesheet is never kept. That test has to change, and the gate allows exactly the tests the pull request's description names, in a section of its own:

```markdown
## Tests the spec contradicts

The spec's criteria contradict these existing tests, so this change may delete, rename or rewrite them, and no other.
Test integrity names each one in its summary.

<!-- factory:contradicts -->
- `test/app.test.ts`: files > keeps nothing of the other files
<!-- /factory:contradicts -->
```

- **Only what lies between the markers is read.** Each line is a test file's path from the repository's root in backticks, `: `, and the test's full name, its `describe` names and its own joined with ` > `. A line in any other form, more than one pair of markers, or more than 10 tests fails the gate, with an annotation saying why. An entry may not have `<!--` or `-->` in it, and a test's name may not have an `@` before a word or a `#` before a digit, which GitHub would turn into a mention or a link: such a test cannot be named, so a change to it fails the gate and the round holds for Martin. `gates/contradicts.ts` reads it and writes it, and the line writes it with the same code.
- **A named test may be deleted, renamed or rewritten.** A rename shows as the old test deleted and a new one added, and the summary lists both. Skipping a named test, `.only`, or rewriting it to assert nothing still fails: a contradicted test is put right or removed, not left dead. An entry names a test, not a file: a file deleted whole excuses only the tests named in it. An entry naming no test the base has excuses nothing, and the summary says so.
- **Every excused test is seen.** The summary has a section for them, and each gets a warning annotation on its file, `"<test>" was deleted, as the spec it was changed for contradicts it` (or rewritten), so it shows in the pull request's files. Only failures go back to the coder, so a warning never reads to it as one.
- **The gate reads the description through the API each time it runs**, never from the event, which holds it as it was when the run began: by the pull request's number on `pull_request`, and in the merge queue by the number in the queue's branch (`gh-readonly-queue/<base>/pr-<n>-<sha>`). That needs `pull-requests: read`, which the test integrity job alone holds, and the app's caller grants. It asks only when the change would fail without the description, so a change that weakens no test never depends on GitHub answering; then a description it cannot read fails the gate. Editing the description runs nothing again: the gate judges it at the next push, or in the queue.
- **The line writes the section** from the spec in force, which the planner wrote, on every push, and takes out any the describer's text has, so neither the coder nor the describer can name a test. **A person can write it too**: Martin, for a test his own change contradicts, or an outside contributor. The review gate holds every pull request Martin did not open, and the summary names every test excused, so an excuse is never silent.

## Tests first

Not required. The change's new and changed tests, with what changed in its test folders, run against the base's source. The check fails unless at least one fails there.
