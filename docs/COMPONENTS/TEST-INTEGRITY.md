# Test integrity

Stops agents weakening tests to get green. Part of the [GitHub plane](README.md#github-plane).

- **v1:** two gates on the app's pull requests ([shared gates](SHARED-GATES.md)).
- **Later:** mutation score on changed code (Stryker); acceptance criteria without a tagged test.

## Test integrity

It reads each test file of the base and the change (`gates/tests.ts`: Vitest's and Jest's `describe`, `it` and `test`, with their modifiers), and fails:

- a deleted test file or test;
- a test newly skipped, left to do, or narrowed with `.only`;
- a test with fewer `expect` and `assert` calls.

A test that moved file under its name has moved, not been deleted.

Each failure is an annotation on its file, such as `"a product page > says when it was last dusted" was deleted`. When the gate sends a change back, the line gives the [coder](CODER.md#its-prompt) these words, and the coder is told the rule before its first round.

## Tests first

Not required. The change's new and changed tests, with what changed in its test folders, run against the base's source. The check fails unless at least one fails there.
