# Samples

What the console shows in development and in its tests, where there is no real work. Part of the [factory plane](README.md#factory-plane).

- **v1:** nineteen hand-written work items (`packages/samples`), typed against the events.

## What they cover

The last seven are fixes as the line makes them:

- rounds of review;
- a wait for Martin's merge;
- each kind of hold;
- a merge waiting for a release;
- a run on the local model.

Their screenshots are real: the app, with each sample's change made in a scratch copy.

## How they are kept

- Exported as an event log that `make check` keeps current, each event with the store's role that would append it (`packages/samples/src/roles.ts`), so the console reads who recorded a refusal from the samples as it does from the store. `events.ndjson` holds each event's public view, which the console, its tests and the replay site read as they read any log. Beside it, `private.ndjson` holds each event's own summary and payload where its public view changes them (a visitor's words, a withheld move's package), so `make samples` (`factory events load`) appends a sample as a real event is appended: its payload checked against its schema, and its public view made by the store, never taken from the log. A test loads them and holds every public view the store made to the log's. The samples are invented, so the private half is published with the rest; the export refuses one that holds an address or anything shaped like a secret but the one the samples make up for the redactor.
- A vulnerable move of the app's lockfile, #1335, withheld in public until its issue opens (`issue.opened`) and named from then on.
- Checked against the answer key in the private repository.

The cluster's store holds real events (`make real-store`).
