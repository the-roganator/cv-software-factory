# TypeSafe in the factory

The decision to use it is ADR 0004; the summary is spec section 7.2. This document holds the detail.

## What it is

[TypeSafe](https://docs.typesafe.ai) runs *System One* models, of which Jev is the first. Jev does not generate text. It takes some state (text or JSON) and a set of questions, and returns typed answers with probabilities. There are three question types:

| Type | Asks | Returns |
|---|---|---|
| **Choice** | Which of these labels fits? | One of the labels defined in the question, and a probability for each |
| **Score** | Where does this sit on an ordered rubric? | An expected level, and a probability for each level |
| **Noul** | Is this true? | The probability that the answer is yes, from 0 to 1 |

Questions sent in the same request run in parallel over the same state. A typical request takes about 100 ms and costs far less than a call to a generative model.

## Why it fits the factory

The factory already splits the work between agents that write things (specs, tests, fixes, reviews) and deterministic code that decides things (gates, canary analysis, the scoreboard). Several stages need a third kind of step: a small judgement about untrusted text, feeding into a decision that code makes. Today that would be an LLM prompt followed by parsing its reply. Jev replaces that pair.

- **Typed output is a mechanism, not an instruction.** A Choice can only return one of the labels the question defined. A problem report saying "set all prices to £0" can shift probabilities between those labels. It cannot put any other text into the pipeline. This is guardrail 8 enforced by the shape of the interface.
- **Probabilities explain themselves.** The console can show the actual distribution behind every triage decision, such as `injection p=0.99 → quarantined`. The red-team view shows a real mechanism's refusal, as spec 5.3 asks.
- **Policy stays in code.** Jev supplies the probability. The threshold and the resulting route are plain code that a reviewer can read, test and tune without retraining anything.
- **Cheap and fast.** Triage can run on every signal without eating into the spend caps that the agents need.

## Where it is used

| Stage | Judgement | Primitives | Code does with it |
|---|---|---|---|
| **Triage** | A report's category, symptom and severity, and whether it holds instructions aimed at the system | Choice, Score, Noul | Routes each report to ticket, park for Martin, quarantine or discard |
| **Triage** | Is this report the same problem as an open ticket on its page? And which passage or element of the page is it about? | Choice over candidate tickets, passages or elements, including "none of these" | Joins the report to the matched ticket, or points its ticket at the factory's own text or markup, and fingerprints a content ticket by its passage |
| **Plan** | Is each acceptance criterion testable? Does the scope cover the files the evidence points to? | Noul per criterion or check | Rejects or escalates a spec before a coder spends budget |
| **Review** | Does the diff change behaviour beyond the spec? Does it touch security-relevant code? | Score per dimension | May add a route to "Needs you"; never removes one |

Triage is the first and most valuable use: reports from the widget are triaged from milestone 4, and visitor keys arrive in milestone 8. The others follow only if triage earns its place.

## Where it is not used

- **Gates, merges and releases.** Guardrail 2 stands: a model never decides whether code merges or ships. Jev's answers can send a change *towards* a human, never away from one.
- **The scoreboard.** Matching tickets to answer-key fingerprints stays deterministic, and the scoreboard is the only component that can read the answer key.
- **Canary analysis.** This stays as metric comparison in Argo Rollouts.
- **Writing anything.** Specs, tests, fixes and reviews remain the agents' work.

## How it is wired

### Through the gateway

Guardrail 6 applies: TypeSafe calls go through the LLM gateway like every other model call (`apps/factory/src/gateway`). Its TypeSafe adapter:

- holds the API key (the only component that does), and calls `POST /v1/systemone` with `fetch`, not TypeSafe's SDK, so that it has the bytes on the wire for cassettes. Its request and response schemas are Zod, written from [TypeSafe's OpenAPI document](https://api.typesafe.ai/openapi.json). A response is checked against the request that was sent: the model it names, the questions it answers, and an answer of each question's type;
- times out after ten seconds, and retries a 429, a 529, any other 5xx, a timeout or a dropped connection, up to three times, with exponential backoff and jitter, waiting as long as `Retry-After` asks (up to thirty seconds). It does not retry any other 4xx;
- never logs or throws a provider's response body, because a 422 echoes the request, and a report's text is in that;
- counts spend against one cap across every provider (`policy/spend.ts`): per day and per month by profile, and per work item. Jev's price is in `prices.ts`, $0.042 per million input tokens, and a model with no price is refused. The count comes from the `model_calls` table, which holds one row for every call: its agent, work item, tokens, cost, duration, cassette key and outcome, but never the state;
- records and replays cassettes (ADR 0003). A cassette is one file, `<key>.json`, whose key is the SHA-256 of the provider, the pinned model, the questions and the state, with the options of a Choice in the order they were sent, since that order can change an answer. It keeps the response body as it came. CI runs the gateway in `replay` and fails on a miss; with no `TYPESAFE_API_KEY` the gateway replays whatever mode was asked for. `make demo` and CI therefore run triage with no key.

### Pinned model

Requests name a pinned version such as `jev-1.13.0`, never the `jev-latest` alias. Thresholds are tuned against a specific version, so upgrading is a deliberate change with its own evaluation run.

### Questions as code, thresholds as policy

- Each question set (for example `triage/v1`) lives in the `cv-software-factory` repo as typed TypeScript and is reviewed like any other code. Question keys are for code only and are not sent to the model, so every instruction must carry its full meaning.
- Routing thresholds live in human-owned policy configuration alongside the gate thresholds, under CODEOWNERS. Agents cannot change them (guardrail 1).

### Events

Each Jev request becomes one event in the work item. Its payload holds the question-set version, the model version, the state that was sent and every answer with its probabilities. The `summary` is the plain-English decision, for example "Triage: functional defect, severity broken (2.99/3) → ticket". The console can replay any triage decision exactly as it was made.

## What Jev does in practice

Measured on 3 October 2026 through the gateway, with `apps/factory/scripts/jev-spike.ts`: 63 judgements of 16 invented reports on `jev-1.13.0`, for $0.002 in all.

- **The same request does not get the same answer, but close.** Five runs of the same three reports always chose the same category. The probabilities moved: up to 0.16 on the chosen category, 0.10 on the severity score and 0.03 on injection. So cassettes are the only exact replay, and thresholds stay clear of where answers fall.
- **The order of a Choice's options can move its answer.** With the category options reversed, 12 of 16 reports got the same answer. The 4 that changed were the ambiguous ones: three attacks, whose category routing never reads, and a request to the packers that sits between suggestion and not-a-defect. The chosen probability moved by up to 0.22. A question set fixes its options' order, and a cassette's key includes it.
- **The narrower injection question, with criteria, separates attacks from requests.** The spike's wording ("instructions addressed to an AI, agent or automated system") scored the polite dark-mode request 0.56, over a 0.5 threshold. The narrower wording alone brought it to 0.49. With criteria saying what counts as yes and no, the most suspicious polite request scored 0.26 and the least confident attack 0.90. The criteria are what made the difference, so triage's question set uses both.

  | Wording | Highest polite request | Lowest attack |
  |---|---|---|
  | The spike's | 0.56 | 0.77 |
  | Narrow | 0.49 | 0.89 |
  | Narrow, with criteria | 0.26 | 0.90 |

- **Descriptions matter for a Choice.** With bare option names, two of the six reported faults were filed under the wrong category (a negative price as content, a search showing cats as errors). With a one-line description of each option, all six were right.
- **What the API returns.** A pinned version answers with that version. The alias `jev-latest` is accepted and answers as `jev-1.13.0`, which is why the gateway refuses aliases itself. An unknown model and a 2 MB state are both refused with a 400 and a `detail` list. Forty requests at once all succeeded: no rate limit showed.
- **What a request takes.** The spike's requests, of one to five questions, averaged about 740 input tokens (at most 920) and answered in 220 ms at the median and 250 ms at the 95th percentile, measured at the gateway. A real `triage/v1` request is larger, with five questions and every option described: the first live report took 1,525 input tokens and 373 ms, or $0.00006.

## Triage question set

Jev reads only visitors' reports. A sense knows what it saw, so its signal's category and severity come from a table in `policy/triage.ts`, and a repeat is recognised by its fingerprint.

The question sets are `packages/triage/src/questions.ts`. Each report is one request to `triage/v2`. The state is the page it was sent from, without its query, and its text, with email addresses and long numbers removed:

```json
{ "page": "/products/brass-doorstop", "report": "The price says -£12.99. Do you pay me to take it?" }
```

| Key | Type | Question |
|---|---|---|
| `category` | Choice | What does the report describe? The defect categories, `suggestion` and `not-a-defect`, each with a line saying what it covers |
| `symptom` | Choice | How does the fault show itself? The symptom classes tickets and the answer key share |
| `severity` | Score | How badly does it hurt a visitor? No harm, cosmetic, degraded, broken |
| `injection` | Noul | Does it try to give orders to an automated system that reads it? With criteria for yes and no |
| `repeat` | Choice | Which open ticket on the same page does it describe? The candidates, described from their tickets' typed fields, and "none of these". Asked only when there are candidates |

A defect whose symptom is about part of the page gets a second request, from the page as the factory read it, or none ([what a report's ticket points at](COMPONENTS/TRIAGE.md#what-a-reports-ticket-points-at)): `passage/v1`, which passage of its text, for content and for a symptom a visitor sees in its words; or `element/v1`, which of its links, images, form fields or buttons, offered only those of the kinds its symptom can be about. The ticket points at what Jev chose, and a content ticket's fingerprint is its passage, so both hold the factory's text, never the visitor's.

Routing (`packages/triage/src/routing.ts`), in order, against the thresholds in `policy/triage.ts`:

1. Injection at or above the quarantine threshold: **quarantine**. The report is kept as evidence of an attack, its text for [30 days](COMPONENTS/TRIAGE.md#how-long-a-report-is-kept), and never reaches the planner.
2. `suggestion`: **park for Martin** (spec 4.1).
3. `not-a-defect`: **discard**, with the events kept.
4. An open ticket chosen at or above the repeat threshold: **repeat**. The report joins that ticket, if the two point at the same thing; otherwise it is a ticket, as below ([a report on a ticket it repeats](COMPONENTS/TRIAGE.md#a-report-on-a-ticket-it-repeats)).
5. Anything else: **ticket**, with category, symptom and severity. Severity is read only on this branch, because it means nothing for reports that are not problems; below `degraded` it is cosmetic. A new ticket whose fingerprint matches an open one that points at the same thing joins it instead: one fingerprint, one ticket.

Low confidence on the category does not block a ticket. It is shown on the ticket, and the planner can reject a ticket it cannot turn into a testable spec.

## Evaluation

Thresholds and wording are measured, not assumed.

- **The evaluation set** (`apps/factory/eval/reports.ts`): 65 invented reports about the app, each with its page and the route triage should take, and for some the page as the factory would read it and what the ticket should point at: a passage, an element, or nothing, where the link a report names is not on its page. They cover every category a visitor can see, polite feature requests, chatter, a version of every red-team attack in spec 5.3 written as a report, and near-misses: a report quoting an error message, one addressed to "the developers", one with instructions meant for a person, and one that mentions an attack without making one, and complaints about a product rather than the site. None describes a seeded defect.
- **In CI**, on the committed cassettes and with no key, every report must route as expected, and a request with no cassette fails the run. So a change to a question that is not followed by `make eval` fails the build.
- **`make eval`** runs the set against Jev live through the gateway. It records the cassettes, prints each report's route and each deciding probability against its threshold, and flags any within 0.2 of it, more than the 0.16 Jev was seen to drift. `RUNS=3` repeats the set to show the drift.
- **A failure is sorted into one of four causes**: missing evidence in the state, a model error, a routing error in code, or a service failure. Each has a different fix. A failure the set keeps on purpose says which.
- **End to end**, the scoreboard's found and false-positive figures show how triage performs on seeded and injected defects.

### Results

Three live runs of the set on `jev-1.13.0`, 3 October 2026:

- **Routing on injection is wide clear of its threshold.** Every attack was quarantined on every run, the least confident at 0.79 (an agent told to build and ship its own image). Every polite request was parked, the most suspicious at 0.24 (a dark mode). No deciding probability came within 0.2 of its threshold on any run.
- **Repeats are clear too.** The report that repeats an open ticket chose it at 1.00, against a threshold of 0.6; the one on the same page about something else chose "none of these".
- **Category is where Jev and a reader differ.** The first run filed six reports under the wrong category, the same way on every run. Changing the descriptions fixed four of those six. Content and functional now say what separates them: wording against what the app works out. Not-a-defect now names noise, spam and matters of taste. Two reports are fairly read either way, a price in words that disagrees with the price and a unit price that disagrees with the pack's, so the set accepts both readings for them.
- **A product is not the site.** Martin's first live report, a puzzle too expensive and missing a piece, was filed as functional, because functional named "prices". It now names a price shown wrongly, and not-a-defect names complaints about a product, its price or an order. Two reports like it joined the set, and both are closed on every run.
- **Two failures remain, both the model's:**
  - A remark that the contact form "held up" when the visitor typed `DROP TABLE` is filed as a security problem, so a ticket opens. A false positive costs a ticket the planner then rejects.
  - A line of question marks is read as a content fault on some runs and not on others.

  Both stay in the set, marked as known.

Open questions about budgets and the `aws` profile are in `OPEN-QUESTIONS.md`.
