# 0006: The app is written correctly, and each defect is a patch

## Decision

The World's Worst Website is written as a correct app, with full tests, in the private repository. Each defect is a small patch kept beside it, with an answer-key entry and a detector: a test that asserts the defect's fingerprint. The app's public first commit is the correct app with every patch applied, written by one script.

The private repository's CI proves the set on every change: the correct app trips no detector; each patch, applied alone, trips its own detector and no other, and leaves the app passing its own checks; every patch together gives the published tree, which trips every detector, passes its own checks and contains nothing from the answer key.

The private repository publishes the app's first commit, and publishes again only at a reset (ADR 0016). Between them the app lives in its public repository and changes there like any other code.

## Why

The factory's results are only worth showing if the defects are real and the score is honest. Both depend on knowing exactly what each defect is.

Writing the app badly from the start gives defects that are only described: nobody can say where one ends and the next begins, whether fixing one fixes another, or whether a symptom belongs to the defect the answer key says it does. A patch is the defect itself. It can be applied alone and proved alone, so "fixable alone" and "one fingerprint each" are tested rather than hoped for.

It also means a defect can be put back. The alternatives for the injector and for reset would each need their own copy of the same knowledge.

## Consequences

- **The scoreboard** matches tickets against fingerprints that have each been shown to appear when, and only when, their defect is present. A false positive is a ticket that matches none of them.
- **The injector** (milestone 8) needs no catalogue of its own: it applies one of the same patches to the app as it then stands, as an ordinary pull request. A patch that no longer applies is a catalogue entry to refresh, and CI in the private repository is where that shows.
- **Reset** applies the patches again to a correct app that has taken in Martin's changes to the public one, so the baseline moves with them, and publishes the result as a new repository under the same name (ADR 0016).
- **Each patch removes the tests its defect would fail**, so the published app passes its own checks. The factory therefore cannot find a seeded defect by running the app's tests; it has to notice the symptom. A fix is expected to bring its test back.
- **Nothing in public says which defects exist**: not this repository, the app's, a commit message, a pull request or an issue. The plan gives their number and kinds only.
- **Publishing is one-way.** The tree is built by a script, checked by CI for giveaways, and read by Martin before it goes public. A defect added between resets arrives as a pull request, through the injector.
- The correct app carries on existing only in private. It is not kept in step with the public app day to day: Martin's changes are brought into it when a reset needs them, and the line's fixes never are, since the patches they undo are applied again.
