# Milestone 7: Admin and guardrails

## Outcome

Martin runs the factory from the console, not from the command line or by hand in the store. He signs in with a passkey and answers what waits on him in Needs you. He also stops and starts the line, sets the autonomy level and the switches, promotes, pauses, aborts and retries a canary, chooses each agent's model and effort, sets the spend caps within what policy allows, and reads the audit log. Everything he can change, a visitor can see, drawn read-only, so the controls that make the factory safe are part of the demo.

He asks for an improvement with the "+" on Plan. It goes down the same line as a fix and ships behind a feature flag that he switches from the console in stages. Verify compares the flag's two sides before everyone gets it.

Every guardrail is proved by a test or by a drill that runs from one command, and its refusals are shown as prominently as successes. Autonomy does what the spec says: under Guarded, an untagged change merges and ships with nobody touching it, and a risk-tagged one waits for Martin. The tags come from deterministic checks on the diff, and the decision to merge is a required check, never a model's word.

The app is kept patched. A security release or a fixable vulnerability in what the app runs, and each routine update, becomes a work item of kind dependency update and goes down the same line, a security one ahead of all other waiting work. A fix its own scans show removes a Critical vulnerability merges and ships with nobody touching it. Everything the factory and the app build or run, lockfiles, images and the platform alike, is scanned every day, and each finding has a deadline by its severity (ADR 0013). A finding in the factory's lockfile or images, or in the platform's, opens an issue and notifies Martin.

The milestone is built in four parts, each by its own orchestrating session:

- **Part A, admin:** sign-in, the access policy, the admin service and its write path, every control in spec 5.4 but the improvements and flags, alerts to Martin, and the local cluster served over HTTPS.
- **Part B, improvements and feature flags:** the "+" end to end, OpenFeature and flagd in the app, flags switched from the console in stages, and Verify comparing a flag's two sides.
- **Part C, guardrails:** every guardrail proved repeatably, the red-team harness, blocked actions in the console, approval routing by autonomy level and risk tag, and the factory run Guarded.
- **Part D, patching:** everything scanned every day with a deadline for each finding, then dependency updates for the app down the line, and an issue and a notification for the factory's own.

Each part starts when the one before has met its criteria and its pull requests are merged. So Part D's scanning waits for Parts B and C, Martin's call: until then, what is already locked or running is watched only by Dependabot's alerts on direct dependencies, the app's pull request gates and Scorecard's weekly score. Each leaves `COMPONENTS/` and `AGENTS.md` describing what it built, so the next session starts from this file, those two and the code, and needs nothing from the session before.

## How each part is built

The part's session orchestrates with the `/implement` skill (`.claude/skills/implement`): it writes a brief for each task from this file, and a sub-agent takes each to a pull request, one at a time, its report checked before it is believed. On top of what the skill does:

- **`/security-review` on every Part A pull request,** and on any in B or C that touches sign-in, the admin service, a credential, a fence or the approval routing. Each brief says so.
- **The orchestrator does what a worker skips:**
  - a `deploy/` change that waits for an image (a new Deployment, a migration, a new setting), opened once Martin has merged the change that builds the image and the App's deploy pull request that pins it. Only the App's deploy watch opens a pin's pull request (ADR 0005);
  - a proof on the local cluster, run with the `try-the-line` skill on Claude, time-boxed and within the spend caps;
  - a drill.

  Each is in the run's summary until it is done.
- **Console designs come first.** Each new view is drawn in the mockup and the design system's README, and agreed with him before it is built. Snapshots are updated in the pinned image.
- **Work in the app's repository** (Part B's OpenFeature and flagd) goes through `/implement` too, each work item's key beginning `app-`.

## Decisions

### Who may do what

- **Two roles, one table.** A visitor reads public views. Admin, Martin alone, reads everything and acts. Every route and every action is in one table in `policy/access.ts`, which CODEOWNERS gives to Martin: its role, whether it reads or writes, and, for a write, whether it needs his passkey again. The server enforces the table and refuses anything not in it. The console draws its controls from the same table, so a visitor sees every control, read-only, with what it does. A test fails when a route or an action is not in the table.
- **Visitors see the controls, not the buttons.** The "+" and every improvement's request, spec and progress; the autonomy level and the switches; each agent's model and effort; spend against the caps; the flags and their stages; the audit log; what waits on Martin and how he answered. Visitor features (milestone 8) add the few writes a visitor's key allows; this milestone has none.
- **What a visitor reads is masked at the source.** Every event's public view is written when it is appended (spec 5.1), so the audit log is open to everyone, with what a visitor wrote and anything shaped like a secret already left out. Martin's answers on holds are public, through the same redactor, except his words on a hold about a visitor's report, which stay his alone, since a paraphrase of a report would pass any redactor. A sign-in's public view says that he signed in, and never the client's address, its browser or the passkey's id.

### Signing in

- **A passkey, and nothing else.** Martin signs in with a passkey (WebAuthn, user verification required): it cannot be phished, nothing reusable is kept on the server, and it works the same on every profile. There is no password and no third party.
- **Enrolled from the command line.** `factory admin enrol` runs with a role of its own, `factory_enrol`, whose password `make` fetches and no pod holds, and which may only add codes and revoke. It prints a one-time code of 128 random bits that lasts ten minutes and allows five tries, counted across every client; Martin enters it on the console's enrolment page and makes a passkey. Enrolment is the one write that takes no session: the code is its credential, used once, and the page still checks `Origin`, accepts only `POST` and is rate-limited by client address. `policy/access.ts` gives it a role of its own, `enrolment code`, and the access tests prove it refuses a request with no code, a used one, an expired one and a sixth try. Every passkey is enrolled this way, so a signed-in session can never add one. He may hold two (a laptop and a phone). `factory admin enrol --revoke-others` is recovery: it revokes every other passkey and every session. Each passkey belongs to its host, so each profile is enrolled on its own.
- **Sessions are kept on the server.** The browser holds only a random id in a cookie named `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`; the store keeps its hash. A session lasts 30 minutes from sign-in with no idle timeout, a figure in `policy/access.ts`: ASVS asks for an idle timeout, and ADR 0012 records why there is none (one admin, who signs in with a passkey and gives it again for every high-impact action). The id changes at sign-in, signing out ends it on the server, and "sign out everywhere" ends them all.
- **Every action that loosens a control, raises spend, promotes something or overrides a guardrail needs the passkey again,** given within the last five minutes, so a stolen session does none of it:
  - raising a spend cap, or a setting that raises spend (a dearer model, more effort, a larger take);
  - loosening autonomy;
  - turning auto-merge on, or auto-rollback off;
  - starting the line;
  - promoting a canary, or retrying a release that was stopped;
  - widening a flag's stage, past the factory's own checks (stage 1, which shows it to nobody else, asks for nothing);
  - approving a hold whose cause is a guardrail: `scope`, `beyond-ticket`, `review`, `gates`, `verify`, `spend` and `merge`;
  - revoking a passkey.

  `policy/access.ts` marks each, and a test holds the spec's list and the table to each other.
- **Every write is defended against forgery:**
  - `SameSite=Strict`;
  - the `Origin` header matched exactly against the console's origin in configuration, never one derived from the request's `Host`;
  - a per-session token in a header;
  - only `POST`, never a write on `GET`.

  Admin responses are `no-store`. A strict Content Security Policy, `frame-ancestors 'none'` and HSTS are on every response. Enrolment and sign-in are rate-limited by client address. WebAuthn's expected origin and relying party come from configuration too, and the tests refuse an assertion with the wrong origin, the wrong relying party, or no user verification.
- **Forwarded headers are believed only from the proxy in front.** Traefik on `local`, and Cloudflare's tunnel on public profiles (spec 8). The client's address that the rate limits key on comes from them alone.
- **The bar is OWASP ASVS 5.0 level 2.** A ZAP baseline scan runs in CI against the console with an admin session, and its findings fail the build unless a reason is kept beside the exception. The scan signs in as a real browser would, with a virtual WebAuthn authenticator enrolled against a throwaway store, so no sign-in path made for tests ships in the image. A short threat model goes in ADR 0012. It counts the console's server among what admin trusts: it never holds a session, but it serves the script that does, so its image is guarded as the admin service's is, and the Content Security Policy is the control.

### The admin service

- **One write path, separate from the console's server.** `factory admin` runs as its own Deployment in `factory`. Traefik routes `/admin/` on the console's host to it, so the browser sees one origin, while the console's server keeps its read-only role and never holds a session or a full event. The session cookie's path is `/`, as `__Host-` requires, so Traefik strips `Cookie` from every request it sends the console's server, and a test proves the server never receives one.
- **Its database role appends Martin's commands and nothing else.** It may append its own event types (holds answered, the line stopped and started, autonomy, switches, settings, release controls, sign-ins) and read the full events Martin's views need. It reads and writes its own tables of passkeys, enrolment codes and sessions, and no other.
- **Only Martin's roles can append Martin's commands.** Every worker may append events, each with a role of its own (task 1), and the intake and the crawler handle what the internet sends, so an event saying `actor: martin` proves nothing. Row security on `events` lets only the admin service's role, and the role `make stop-the-line` and `make start-the-line` use, append the admin event types; the store stamps each event with the role that appended it (`current_user`, never the client's to set); and the line, triage and the gateway act on an admin event only when that role is one of Martin's. Workers get no grant on the passkey, code and session tables. A test of the grants proves each, and that an admin event appended by any worker's role is refused.
- **It serves Martin the full events.** A live stream of full events, the public one's twin, goes to a signed-in session, which the stream checks again every few seconds, closing as soon as the session is signed out, revoked or expired. Report text is shown to him as spec 5.3 says, inserted as text.
- **It is the one service of ours that may touch a Rollout.** It gets a Role in `website` that may patch the app's Rollout and its status, by name, for promote, pause, abort and retry. A Role names objects, not fields, so a ValidatingAdmissionPolicy refuses any change of the admin service's to the Rollout but `spec.paused` and the status fields promote, abort and retry set. `release-fences.test.ts` keeps every other service account away from the Rollout, and fails if this Role or that policy grows.
- **Every action is an event.** Martin is the actor. The public view says what he did, and the console's audit log reads it like any other event.
- **Stop the line keeps its command-line path.** `make stop-the-line` does not go through the admin service, so it works when the console does not.

### Settings within policy

- **Policy sets the bounds; Martin chooses within them.** `policy/models.ts` names the models each agent may use on each profile (Claude Haiku, Sonnet and Opus to start, and Qwen where the profile has a local model, each priced in the gateway) and the highest effort for each. The console offers an agent only the models its profile has, so a local model is one choice among them, agent by agent, and a cloud profile offers none. `policy/spend.ts` names each cap's ceiling. Martin's choice is a settings event, and the gateway reads the latest. Raising a ceiling, or adding a model, is still a pull request.
- **Settings are checked where they are read, not only where they are written.** The gateway and the line check each settings event against policy as they read it, and fall back to policy's defaults for anything outside it; zero, null and anything not a finite number are never "no cap". A test appends an out-of-policy event straight to the store and shows it has no effect.
- **A setting applies from an agent's next step,** never part-way through one, and the step records the settings it ran under.
- **The line's take settings join them.** `LINE_TAKE` and `LINE_ONLY` become settings Martin changes in the console, with the variables as their defaults for a line on the host.

### Local HTTPS

Safari drops a `Secure` cookie over plain HTTP, even on `localhost`, and passkeys need a secure context. So the local console is served over HTTPS:

- `make up` creates a local certificate authority constrained to `localhost` and `.localhost` names, with `step` (pinned in `mise.toml`; `mkcert` cannot constrain one), which the Mac trusts once, and gives Traefik one certificate for the local hosts. Anything on the Mac that reads its key can mint certificates for those names alone, never for GitHub or anything else.
- The console moves to `https://console.localhost:8443`; plain HTTP on it redirects.
- The app's own hosts stay as they are, so the traffic generator and the canary's split are untouched.

Public profiles get their certificates from Cloudflare (milestone 10).

### Alerts to Martin

- **Alertmanager gets a second receiver, Pushover,** beside the intake. Its key comes from the Keychain through `make up`, as the other keys do. Alertmanager has no NetworkPolicy today; it gets its first, which lets it reach the intake and the internet on 443 and nothing else, as Kyverno's rule does until egress by host name (#176), and lets in only Prometheus and Grafana, since anything that reaches it could silence a page. A silence is itself a security event. `make egress` covers it.
- **Four levels, routed by label:**

  | Level | For |
  |---|---|
  | Page | the console or the app down, the line stuck, a spend cap reached, a security event that loosens a guardrail or changes who can sign in |
  | Notify | a release rolled back or errored, a new hold, a security event that widens what the line does or acts on a release, a security release or fixable vulnerability in a factory image |
  | Inform | a security event that tightens, but for autonomy, or only records Martin's own use, such as signing in |
  | Dashboard only | everything else |

- **Security events come first (Part A):** a sign-in, a passkey enrolled or revoked, every action that needs the passkey again, and every change to a setting. They are counted from the stored events by a worker other than the admin service, so a compromised admin service cannot keep quiet, each count starting at zero so the first of a kind alerts too, and an alerting rule alerts on any, at its kind's level. Factory health, releases and spend follow in Part C, and its images' vulnerabilities in Part D.
- **Whether the factory is up is answered from outside it.** On public profiles, an always-firing alert goes to a dead man's switch, and an outside check watches the site and the console (milestone 10).

### Feature flags (Part B)

- **OpenFeature in the app, flagd beside it.** The app asks OpenFeature, the CNCF's standard API for flags; flagd answers. flagd runs in a namespace of its own, `flagd`, not in the app's pod or beside it in `website`, so the app's pods keep no token and no route to the Kubernetes API, and nothing the app's repository may write in `website` can touch flagd, its service account or its state. The app uses flagd's provider in-process: it holds a copy of the flag set, kept in step by flagd, and evaluates each request itself, so no request waits on flagd. flagd's image is admitted by digest in a copy of admission of its own, `flagd-images`, which admits nothing else, so `website-images` still admits no third-party image.
- **The flag is defined in the change; its state is Martin's.** An improvement's pull request defines its flag in the app's code, with its default off, and the spec names it. The state of every flag lives in one `FeatureFlag` resource (OpenFeature's `core.openfeature.dev` kind), `flags` in `flagd`. Only its definition is installed, not OpenFeature's operator. flagd watches it through the Kubernetes API, so a change reaches the app in seconds, and a kill switch needs no deploy or rollback. flagd's watch lists the whole namespace, so its Role may read `featureflags` in `flagd` with no names, and writes nothing; an admission policy keeps `flags` the only one there, and refuses its deletion, since flagd keeps the last flags it read when its resource goes. Off is a change to the resource, never a deletion.
- **Argo CD makes the resource and never touches its flags.** It is in Git with no flags, made before flagd starts (flagd does not start without it). `root` gains `RespectIgnoreDifferences` and ignores the resource's flags, as the local overlay already does for the Rollout's `spec.paused`, so a merge never puts Martin's stages back. Only the admin service may change them (the same kind of Role as the Rollout's).
- **The admin service writes typed stages, never flagd's own JSON.** Each stage keeps the ones before it, and each is a fixed shape of flagd's targeting: on for the mark; then for the flags a preview names too; then, for a request the app marks as signed, flagd's `fractional` rule over the signed id, with two variants weighted by the share and the rest; then on for everyone. The share is the only parameter. The same kind of admission policy as the Rollout's allows those shapes and nothing else. A flag the resource does not name is off, by its default in the app.
- **A stale flag set fails off, and a narrowing is confirmed.** The provider keeps serving the last flag set it read while flagd is away, so a kill switch would not reach it. When the provider has been stale for a minute, the app treats every flag as off, and a test shows it. flagd's readiness follows its watch at start only: with `flags`, its Role, its binding or the API missing it is never ready. A watch broken after start (its binding gone, the API unreachable, a resource it rejects) leaves flagd up and ready, serving the last flags it read, so it is caught from outside: the app reports the revision of the flag set it holds to a marked request, and the admin service probes every 60 seconds, comparing the revision in `flags` with the one the app reports; when they have differed for more than 5 minutes, a Prometheus rule alerts Martin, through Alertmanager, on his phone. And after every narrowing or off the admin service checks that the app has it; when it has not within a minute, Martin is notified.
- **A flag goes out in stages,** each one change in the console:
  1. the factory's own checks' requests, so Verify can check the change in production with nobody else seeing it. The mark is the header those checks already send (`x-unmeasured`), which the app already leaves out of its telemetry: the app's ingress strips it from every request that comes through Traefik, and the app's NetworkPolicy lets in, beside Traefik, only the probes, the crawler and the canary's journeys. So only the factory's checks can make it, and the network enforces that rather than a key. The strip is in the app's repository, so an admission rule here requires every route to the app to use exactly that Middleware, and refuses any other Middleware in `website` that sets the header, chains others, or runs a plugin. The traffic generator, which stands in for the visitors, comes through Traefik and never makes it;
  2. browsers that opt in to preview it, the preview cookie counting from this stage on and never before;
  3. a share of the traffic generator's requests, by an id it sends with each one and signs. The generator holds an Ed25519 private key in a Secret of its own, and signs one canonical message (a fixed context string, then the id, the time, the host, the method and the path, each length-prefixed); the app holds only the public key, accepts a signature less than a minute old, and not from the future, for the request it was made for, and ignores an id without one. With no public key, or one it cannot read, nothing is signed. A signature is a bearer credential, so what keeps visitors out is that none ever sees one: the generator's requests go from its pod to Traefik's Service inside the cluster, on every profile, and neither Traefik's access log nor the app's logs or spans ever record the id or its signature. Anything that read one could replay it, for that page and that minute, and the worst it does is show a feature at the share stage and add a request to the figures;
  4. everyone.

  Off is a kill switch for everyone, and beats a preview. Martin widens a flag one stage at a time, so Verify checks each, except that the opt-in stage may be skipped, from stage 1 straight to the share; and everyone waits for Verify's comparison at the share stage. A flag turned off after everyone had it may go straight back to everyone.
- **The app's flag context is Martin's.** The app's code, which the line's agents write, builds the evaluation context: it reads the mark, checks the signature and names the preview. A key the app does not hold stops a forgery, not a bypass, so that module is code-owned in the app's repository, and a change to it waits for Martin in every mode. It is the only code that may import OpenFeature or flagd's provider, which a lint rule in the app's code-owned `biome.json` enforces, and it offers the rest of the app one question: is this flag on for this request. Stage 1's pictures, off and on, show that a change is behind its flag at all.
- **Verify compares a flag's two sides at the share stage, on the traffic generator's requests.** The factory's checks' requests are too few to judge on, and are left out of the app's telemetry, so stage 1 checks the change, the probes' journeys among them, and the share stage compares. The code being judged must not label its own figures, so the generator measures each request's status and time itself, by the id it carried, and does not work out sides: Verify, which knows from the admin service's events which flag is at the share stage and its share, maps each id to its side with flagd's own `fractional` rule (flagd's evaluation library, in Verify). The generator never reads `flags` or connects to flagd. Visitors' requests are never in the figures. Verify judges flag-on against flag-off on errors and latency from the generator's figures, with the canary's thresholds. The app writes the variant on the request's span too, to read a trace by. The generator spreads its walk over enough ids that each side gets the same mix of pages and enough requests. Only one flag is at the share stage at a time, so each comparison varies one thing.
- **Stage 1 checks the change by its pictures and the journeys.** The probes are written blind, from the spec rather than the code, and none knows a new feature. So stage 1 shows the change rather than proving its criteria: the probes' journeys and the `/device` check pass with the flag on, and their pictures of the pages the spec names, from the release (off) and from stage 1 (on), are the work item's evidence. The criteria are proved by the pull request's own tests, with the flag on and off, and Martin judges the pictures when he widens. A check of an improvement's criteria written blind is not part of this milestone.
- **A canary and a share take turns.** During a canary, a flag at the share stage would split its two versions' requests too, and Verify's comparison would mix the versions. So the admin service refuses to widen a flag to the share stage while a canary is in flight, and the console says why; Verify sets aside any window a canary overlaps; and the generator's ids turn independently of the canary's split, as its walk already does, so a flag left at the share stage gives a canary's two sides the same mix. A release never waits for a flag.
- **The browser is checked at stage 1, not compared.** No visitor is kept on one side before stage 4, since that needs an id on their device, and the generator runs no browser. So what a change does in a browser (a script error, a page made unreadable) is for stage 1's journeys to check, and they must pass before the flag can widen. Once a flag is on for everyone, a regression is a ticket like any other, and the kill switch is one click.
- **Martin's commands about improvements and flags are his.** An improvement's request and every flag's stage are admin event types, appended only by Martin's roles, as Part A's are, so no worker can open an improvement or stage a flag in his name.
- **An improvement widens what the line does, so it is guarded as a widening.** Asking for one and approving its spec each need the passkey again, and each is a security event at Notify, so a stolen session cannot set the line building something new unseen. An improvement's pull request waits for Martin's approval in every mode, as a release's does.
- **A preview is the app's own feature, and harmless.** `?preview=<flag>` sets the app's preview cookie. The console's "Preview it" link uses it during the opt-in stage. The app accepts only flag names flagd knows, never echoes the parameter, and someone who sets it by hand sees a deployed feature in their own browser only. The cookie is set only when someone asks for the preview, to give them what they asked for, so it is strictly necessary.
- **Nothing on a visitor's device that they did not ask for.** Neither the console nor the app has a cookie banner, so each keeps on a visitor's device only what is strictly necessary (PECR regulation 6, as the Data (Use and Access) Act 2025 amends it, and the ICO's guidance on storage and access). Today that is the console's `__Host-session`, once Martin signs in. Flags add the preview cookie, and nothing else: a share of visitors would need an id kept on each device, and telling them apart by address and user agent instead is turned down too, since the same rules reach it and the factory relies on none of their exemptions. Whatever pull request adds a cookie, or anything else kept on a device, adds it in the same pull request to the device gates' allow-list (the console's browser tests, and the probes' `/device` check for the app), and names it on the console's privacy page and, when it is the app's, on the app's `/privacy`. The probes' allow-list lives in this repository, so an app's cookie is allowed here, in a pull request that merges first, and the app's own pull request names it on `/privacy`.

### Autonomy (Part C)

- **Risk tags that a diff can show are worked out from it.** Deterministic checks tag a change:
  - test-loosening, when a test is deleted, skipped or weakened, as the test-integrity gate judges it (a new test, which every fix brings, is not one);
  - dependency-change, for a lockfile or a package manifest;
  - security-headers, for the header settings.

  Out-of-scope is not in a diff, since the scope fence refuses a file beyond the spec's scope before it reaches GitHub. It stays the planner's tag on the spec, and the reviewer's, held for Martin before any code is written in every mode. The planner and the reviewer may add any tag and hold the work for Martin; neither can remove one. The routing check works out the diff's tags itself, never from labels, and fails a pull request whose risk label anyone but Martin has removed.
- **Merging is decided by a required check: the review gate is the approval-routing check.** One required check, `review`, posted only by the review App from `main`'s copy of `review.yml` (ADR 0014), passes a pull request when
  - Martin opened it;
  - Martin approved its head commit;
  - the factory's App opened it and it is low-risk: it has no risk tags, which the gate works out from the diff, never from labels; it touches no path CODEOWNERS gives Martin; and it is neither a release nor an improvement, which the gate tells by a change to the app's typed list of flag names (task 24); or
  - it is an exact pin (below).

  That is Guarded's rule, and the gate needs no mode to hold it: Supervised is the line adding nothing to the merge queue. Lights-out also passes, in the app's repository, the factory's App's pull requests with risk tags, but never a release, an improvement or a path CODEOWNERS gives Martin; and never a work item whose spec carried `out-of-scope`, which the gate cannot tell from a diff, so the line, which can, never adds one to the queue (task 24). From Part D, the gate also passes a Critical vulnerability's fix under Guarded, as Patching (Part D) says. A release pull request waits for Martin in every mode: it publishes a version, and nothing waits on it. So does an improvement's: it is new behaviour Martin asked for (Part B).
- **The gate knows Lights-out by a repository variable** (Martin, 2026-10-28). The autonomy level lives in the factory's store, where a GitHub runner cannot read it, and nothing the App writes, such as a label, can carry it, since the App's pull requests are what the gate judges. So `AUTONOMY`, a variable of the app's repository that only an admin (Martin) can set, read by the shared `review.yml` as its caller's variable, says Lights-out to the gate; this repository's never matters, since the App merges nothing here but pins. The line reads the store's level. The gate's verdict names the rule that passed, and the line adds a pull request to the queue only when that rule is allowed at the store's level, so the stricter of the two always wins. Neither the factory's App nor any worker's credential may write repository variables, and a test (task 20) and a proof (task 21) show it. Guarded needs no mode signal.
- **Martin's approval is his own GitHub review of the head commit.** The App writes labels, comments and check runs, so none of them can carry his approval. The check reads his review and requires its commit to be the pull request's head, so a push after he approved fails it; a test shows that. His Needs-you card for a merge links to the pull request.
- **A deploy pull request passes only as an exact pin.** The gate compares lines: only `digest:` values change, each to an image `build.yml` signed on `main` whose commit descends from the pin it replaces, so nothing else in the file can move and no pin goes backwards.
- **In this repository, the App merges nothing but pins unattended.** The factory's own code (its gates, its GitHub worker, the gateway, the admin service, the store's migrations and the redactor) is never merged without Martin, in any mode: any other App pull request here fails the check. The gate runs from `main`'s copy of `review.yml` and reads CODEOWNERS from `main`, so a pull request cannot rewrite the check that judges it; those paths become code-owned, as the gate's script is.
- **Every pull request of the App's that touches a path CODEOWNERS gives Martin fails the check,** but for an exact pin.
- **The line adds a pull request to the merge queue, and the queue merges it.** The line adds one (`enqueuePullRequest`) only when the autonomy level and the auto-merge switch allow, and the queue merges only once every required check, `review` among them, passes. So there are two locks: a fault in the line cannot merge a risky change, which the gate fails, and the gate alone merges nothing, since a pull request merges only once the line or Martin adds it to the queue. Nobody bypasses anything: `main`'s one ruleset has no bypass, the App's included, so a fault in the line cannot touch a rule.
- **Autonomy is set in the console.** Loosening it needs the passkey again and pages Martin; tightening is immediate.
- **Each required check is pinned to the integration that posts it.** `github-settings.ts` pins every required check but `review` to the GitHub Actions integration, so the App's own check runs cannot satisfy one. `review` is required from the review App's integration (id `5470762`), which is stronger than pinning it to GitHub Actions, as a pull request could satisfy that by adding a workflow job of the same name: only `main`'s copy of `review.yml` can use the review App's key. Lights-out is built and proved, and never the default.

### Patching (Part D)

- **Everything is scanned, every day, in CI (ADR 0013).** One scanner, Trivy pinned by digest, reads each repository's lockfile, development dependencies included; each image of ours `main` pins, from the SBOMs `build.yml` attests; each third-party image pinned by digest (Postgres, its exporter, the proxy's nginx, flagd); the platform's charts' images at their pinned versions, the k3s node image's, and the load balancer and tools images k3d starts; and the Node binary in each. The list is worked out from the repositories, and a test fails when a rendered manifest runs an image not on it. An item the scan cannot read is a finding in itself, and a scan that cannot fetch the day's advisories fails rather than passing. Results go to each repository's code scanning, one alert for each package and advisory; the app calls the scan from here at a pinned commit, as it calls Scorecard.
- **Every pull request in both repositories scans its lockfile** against the base's, read-only, and fails on any known vulnerability the change brings in. GitHub's dependency graph does not read these pnpm lockfiles, so dependency review and Dependabot's alerts see direct dependencies alone; the graph is submitted from Syft's SBOM on each push to `main`, so Dependabot alerts on every package, though it opens security updates for direct dependencies alone, and the gate never depends on it.
- **Each finding has a deadline,** counted from the day its fix can be installed: Critical 2 days, High 7, Medium 30, Low 90. The daily scan reports each open finding's age, and fails on a new High or Critical, one due within a day, or a deadline passed. Its public log gives counts; the packages and advisories are in code scanning. A finding with no fix has none, and is looked at again when one appears.
- **Exceptions are Martin's, in `policy/vulnerabilities.ts`:** the repository, the advisory, the package, why it cannot reach us, and an expiry within 90 days. The scan reads them from this repository's `main`, whatever commit the app pins, checks each expiry against the day, and never reads an ignore file from the repository it scans. Each repository's `osv-scanner.toml`, which Scorecard reads, is generated from them, and the daily scan reports one that differs, never failing a pull request for it.
- **What is running is compared with what was scanned.** One sense, daily, reads the digests deployed and the day's results, with the App, and makes a signal of each fixable High or Critical finding in an image the app runs, and of Node's security releases on the line `mise.toml` pins (Node's release index). A running digest the scan has no result for, or a running image not on the scan's list, is a finding in itself, so drift from `main` and an image the list missed are both caught. The app's Dependabot pull requests and alerts are read too, now that the graph is complete.
- **Two ratings, two uses.** A finding's severity, which orders its ticket and its alert, is the higher of the scanner's rating and that of the project that published the fix. Whether a fix merges without Martin is decided by the gate's pinned scanner's rating alone: the publisher is the party whose code would merge, so its rating can hold a change, never release one.
- **A finding is a ticket like any other.** Kind dependency update, category security for a vulnerability. A fixable High or Critical takes `broken`, the top severity, so the line takes it next: it already takes the oldest open ticket of the highest severity. Work already in flight finishes first. A routine update takes `cosmetic`, behind the defects.
- **An update moves every pin of what it updates.** Node in the app is pinned in `mise.toml`, the build stage's `node:` image and the distroless runtime's digest, and the runtime's tag does not name its Node. The coder moves them together, and the app gets the factory's test that keeps them in step. A Dependabot pull request for the same update is taken up rather than opened again.
- **Dependabot's settings stay, but for new pins.** Its cooldowns, its groups (Playwright's across npm and docker, and one pull request for each image across the `docker` entry's directories) and the mirror's lead over them are unchanged. A new pin gets its directory, as flagd's has (task 14) and Trivy's will, so that the scanner is kept current (task 28), with a cooldown that applies only where its registry gives Dependabot a publication date (Risks): the speed comes from the sense, and a shorter cooldown would only bring a pull request that fails the pin test sooner.
- **A Critical vulnerability's fix merges without Martin; every other update waits for him.** Under Guarded, the routing check passes a dependency change only when all of these hold, and holds it for Martin otherwise:
  - **The scans show the fix.** The gate's pinned scanner rates the vulnerability Critical in the base's image. The change's scan still lists the same package, at or above the advisory's fixed version, with the finding gone. A finding that disappears is not a fix: the change's scan must list every package the base's does, and the Node binary, bar the versions that moved. A package removed or renamed, an alias, a tarball or git source, or a report that does not parse holds the change.
  - **Nothing new.** The change's scan finds nothing new at High or above.
  - **Only what the fix needs moves.** Every package whose resolved version changes, and every package the lockfile adds, is the one the fixed finding names or a dependency its new version requires. A group pull request, or a change that moves anything else, keeps its tag.
  - **Pins only.** The diff changes `mise.toml`'s Node, `FROM` and image digests within the same repository, and versions of packages already there, with their lockfile entries. Nothing else: never a workflow's `uses:`, and never an image from another repository.
  - **Every gate passes.**

  The fix is read from the scans, never from an advisory's or a pull request's words. The canary still guards after the merge, and Martin is notified of each such merge. Any other dependency change keeps its dependency-change tag and waits in Needs you with the lockfile change and the scan's summary. The scanner must see the Node binary itself, not only the packages, proved as task 28 is.
- **The factory and the platform are patched by Martin.** The line works only in the app's repository. A finding in the factory's lockfile or images, or in the platform's, opens an issue here, updated rather than opened again, that `/implement` can take as it stands: the release, its highest severity, its deadline and each pin to move, the Playwright image's among them, since its tag does not name its Node either. It notifies Martin at Notify. Dependabot's security updates cover direct dependencies; an indirect one is a lockfile refresh from the issue. Routine updates stay Dependabot's, and reach Martin as its pull requests do.

## Part A: admin

Each task is its own pull request, in order, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above.
- No hold waits in the store: Martin closed work item 1002 on 2026-10-09 (`work-item.closed`, `no-change`). The holds answered from the console in task 12 are ones a run on the local cluster makes.

### 1. A store role for each worker (#435)

- Each worker that uses the store (triage, the line, the gateway, the probes, the crawler, the intake and the log watcher) connects as a role of its own, granted only the tables and columns it uses. The GitHub worker and the traffic generator never connect to the store, and get none. The grants say in one place what each worker may touch, and a test of each role's grants fails if one grows.
- Every worker may still append events, through a role they are all members of, so task 4's row security names Martin's roles once and refuses every worker's.
- The roles' passwords come from Secrets `make up` makes and the migrate Job sets, as the scoreboard's do, with a `make` target for a cluster made before.
- It rolls out in three steps, each a merge and a deploy: the roles, in a migration; each Deployment switched to its own Secret, once the image that migrates them is pinned; then `factory_writer`'s grants on the tables taken away, and the role with them.

### 2. Local HTTPS

- `step` in `mise.toml`; `make up` makes the local authority, constrained to `localhost` names, has the Mac trust it, and gives Traefik its certificate as a Secret. A test shows the authority refuses to sign for any other name.
- `deploy/k3d/cluster.yaml` maps `127.0.0.1:8443` to Traefik's 443. On a cluster made before this, `make up` adds the port in place (`k3d cluster edit`, which makes only the load balancer again), so the store keeps its work items; it says so where people will see it.
- The console on `https://console.localhost:8443`, with plain HTTP redirecting: its ingress in `deploy/overlays/local/`, the addresses `make up`, `make samples`, `make real-store` and `make status` print, `AGENTS.md`, the e2e tests and the `try-the-line` skill.
- `make up` on a fresh clone still works for someone who declines the trust prompt, and says what they lose.

### 3. The designs

- In the mockup and the design system's README, agreed with Martin before anything is built:
  - the bottom row (Needs you and Controls);
  - sign-in and enrolment;
  - the settings;
  - the audit log;
  - promote, pause, abort and retry on the Canary panel;
  - preview as visitor;
  - each one's read-only form for visitors.
- The README's "Not decided yet" loses what this settles.

### 4. Sign-in and the access policy

- `policy/access.ts`, and the test that every route and action is in it.
- `factory admin`: its Deployment, NetworkPolicy, Traefik route and database role, with its migration and a test of its grants. A `deploy/` change follows its image.
- The store's guard on Martin's commands: row security on `events` for the admin event types, the appending role stamped on each event, the line, triage and the gateway checking it, `factory_enrol` and the role the make targets use, and no worker's grant on the admin tables.
- Passkey enrolment and sign-in, sessions, forgery defences, headers and rate limits, as the decisions say. `factory admin enrol` and `--revoke-others`.
- Tests:
  - every write route refuses no session, an expired session, a revoked one, the wrong origin and a missing token;
  - enrolment refuses no code, a used one, an expired one and a sixth try;
  - an admin event appended by any worker's role is refused, and one with `actor: martin` from any other role is ignored;
  - the cookie's flags, and that the console's server never receives it;
  - the id changes at sign-in;
  - a WebAuthn challenge cannot be used twice, and an assertion with the wrong origin, the wrong relying party or no user verification is refused;
  - step-up is enforced on every action the table marks;
  - signing out, revoking and expiry close an open full-event stream;
  - forwarded headers from anywhere but the proxy are ignored.
- The ZAP baseline scan in CI, and ADR 0012 with the threat model.

### 5. Martin's view

- The full-event stream to a signed-in session; the console draws full events for Martin and public ones for everyone else from the same projection.
- A report's text for Martin, as spec 5.3 says.
- Preview as visitor: the public stream, served by the server, not hidden in the browser.

### 6. Needs you

- The bottom row's Needs you: one card per hold, the line's and triage's, with its cause, its evidence and what each answer does (`ANSWERS`).
- Approve, reject or answer in words, appending `hold.answered`; words on a triage hold leave it held, as `WORDS_LEAVE_HELD` says.
- For visitors, the same cards, read-only, with Martin's answers once given.

### 7. Release controls

- The admin service's Role on the app's Rollout, the admission policy that holds it to the fields its controls set, and `release-fences.test.ts` updated to allow it alone and to fail if either grows.
- Promote (to the next step, or fully), pause, abort and retry on the Canary panel, each an event with Martin as its actor. Martin's abort is `release.aborted` with `by: martin`, recorded by the control rather than inferred from time: the version before takes all the traffic, nothing failed, and it is no signal. A rollback stays the analysis's alone. A retry ends the "until Martin retries it" holds that today take a `kubectl` patch.

### 8. The line's controls

- Stop and start the line from the header, with a reason: the same events as `make stop-the-line`, and a canary in flight aborted through task 7's Role, as `scripts/abort-canaries.sh` does with Martin's own credentials. `make stop-the-line` keeps its own path.
- The autonomy level, recorded; Part C makes it route.
- The switches spec 5.4 names: agents taking new work, and auto-merge of low-risk changes, which does nothing until Part C. Auto-rollback is Part C's.
- The line's take settings, read by the line in place of its variables.

### 9. Models and spend

- The bounds in `policy/models.ts` and `policy/spend.ts`, the settings event, and the gateway reading it at an agent's next step.
- The settings page: each agent's model, from the profile's models, local ones included where it has them, its effort, and the caps; raising a cap answers a `spend` hold.
- Spend against today's caps in Controls, for everyone.

### 10. The audit log

- Every agent action, model call and admin action, newest first, filtered by actor, work item and kind; the same view for everyone, from public views.

### 11. Alerts

- Alertmanager's Pushover receiver, its key from the Keychain, and its first NetworkPolicy, with `make egress` showing it reaches the intake and the internet on 443 and nothing else.
- The routes by level, and the security events' rule, counted from the stored events outside the admin service, and Alertmanager's ingress limited to Prometheus and Grafana.
- A test alert on Martin's phone: a sign-in reaches it.

### 12. The runs

On the local cluster, on Claude, at Supervised:

- The holds a time-boxed run on the local cluster makes, at least one with a guardrail cause so step-up is proved, answered from the console, and the line acting on each answer. Nothing is seeded into the store.
- The line stopped and started from the console, and a canary paused, promoted, aborted and retried from it.
- An agent's model changed in the settings, and its next step running on the new one.
- Martin uses it all on a laptop and a phone, and approves it against `INTENT.md`.

### 13. Documentation for Part A

- `COMPONENTS/`: the console, a new admin page, the event store's roles, alerting, the gateway's settings, progressive delivery's controls, and the guardrails table.
- `AGENTS.md`: the console's address, enrolling, and Pushover's key.
- `TERMS.md`: admin, passkey, step-up, setting.
- Spec sections 5 and 8, and ADR 0012.

### Part A is done when

- [x] Every worker uses the store with a role of its own, `factory_writer` has no grant on its tables, and the test of the grants passes.
- [ ] Martin signs in with a passkey on a laptop and a phone, in Safari and Chrome, and no write succeeds without his session: the access tests and the ZAP scan pass. On the local cluster the phone is Pushover on his phone and the console's layout at phone width; using the console on the phone itself waits for the cloud (milestone 10), so this stays open (Martin, 2026-10-24).
- [x] Every hold a run on the local cluster makes is answered from the console, a guardrail's among them, and the line acts on each: a failure answered in words, and a spend hold approved with the passkey and answered again by a raised cap (2026-10-24).
- [x] Stop the line, autonomy, the switches, what the line takes, the release controls, the models and the caps are each changed from the console, recorded as events, and shown read-only to a visitor (2026-10-24): the line stopped and started from the header; autonomy, the take and both switches changed, auto-merge on with the passkey; a canary paused, resumed, aborted, retried and promoted; an agent's next step run on a changed model; a cap raised.
- [x] A sign-in reaches Martin's phone (2026-10-24), and each hold that waits for him, with its links.
- [x] The audit log shows every action, with nothing a visitor wrote in its public form.

## Part B: improvements and feature flags

Each task is its own pull request, or a few in order, each demonstrable. Work in the app's repository goes through `/implement` like the rest, and nothing it writes there, in code, commits, pull requests or replies, mentions or hints at seeded defects.

### 0. Settled before the start

- Martin has agreed the decisions above (2026-10-24).
- **`/implement` takes work in the app's repository,** the run's first pull request. A work item may name the app's repository. Its worktree lives under this checkout's `scratch/`, its worker follows the app's `AGENTS.md` and `docs/REVIEWERS.md` and runs the app's `make check`, its description is written by `/visual-pr` with the app's pull request template, and every brief for it carries the rule on seeded defects. A pull request that needs one in the other repository first says so, and the orchestrator orders them.
- **Carried from Part A:** the store (`DiskArtifacts.open()` in `packages/store/src/artifacts.ts`) and the console (`artifact()` in `apps/console/src/app.ts`) each read an artifact's size apart from opening it, so a file replaced between the two reads sends the wrong `Content-Length`. Each opens once and takes the size from the handle, in a small pull request of its own.

### 14. OpenFeature and flagd

Platform work in both repositories, each pull request in its own, in this order:

- **flagd in `flagd`** (here): the namespace, with a default-deny NetworkPolicy; the `FeatureFlag` resource's definition; the resource `flags`, with no flags, synced before flagd, and `root`'s `RespectIgnoreDifferences` with its flags ignored; flagd's Deployment and Service, at a release at least two weeks old, its readiness following its first read; its service account, and a Role, bound to it alone, that may `get`, `list` and `watch` `featureflags` in `flagd` and nothing else; and the admission policy that keeps `flags` the only one and refuses its deletion. flagd's NetworkPolicy lets the app's pods reach its sync port alone, from which their in-process provider streams the flag set, and lets it reach the Kubernetes API, DNS and the collector; the app's policy gains egress to that port. `flagd-images`, admitting flagd's digest alone, and `make admission-ready` covering it. The fences' tests: flagd's Role reads `featureflags` in `flagd` and writes nothing, its binding names flagd's service account alone, only the admin service may write `flags`, and the cluster's own controllers (Argo CD's, Kyverno's) are the trusted exceptions, named.
- **The mark kept here** (here): an admission rule in `website` that every route to the app uses exactly the Middleware that strips `x-unmeasured`, whose content it fixes, and refuses any other Middleware there that sets that header, chains others or runs a plugin, with a refusals record for each; and a test that Traefik reads no route across namespaces.
- **The generator's id** (here): `make up` makes an Ed25519 key pair once, gives the private key to the traffic generator as a Secret, and the public key to `website` as the ConfigMap `share-key`, which an admission rule lets no one but `make up`'s user write, so a ConfigMap from the app's repository cannot replace it. The generator sends a signed id with each request, from a set of ids it keeps, and its NetworkPolicy keeps it to Traefik inside the cluster. It records each request's status and time, by its id, as its own metrics, and works out no sides (Verify does, task 17). Traefik's access log leaves out the id's and the signature's headers. A `make` target for a cluster made before.
- **The preview cookie allowed** (here): the probes' `/device` check gains an allow-list for the app, with the preview cookie alone, and the console's privacy page names it. It merges before the app's pull request that sets it.
- **OpenFeature in the app** (the app's repository): the server SDK and flagd's provider, in-process; `docs/REVIEWERS.md`'s "nothing new to install" names each package they bring as allowed, a change of Martin's in the same pull request. The flag context in a module of its own, code-owned in the app's `CODEOWNERS`, the only importer of OpenFeature and the provider (a restricted-import rule in the app's `biome.json`), offering the rest of the app only whether a flag is on for a request: the mark, the flags the preview cookie names, and the id as the targeting key with the signed mark once its signature checks out, with no key meaning nothing is signed. The variant on the request's span; neither the id nor its signature in any log or span. The revision of the flag set it holds, told to a marked request. `?preview=<flag>` sets the cookie for a flag flagd knows, and nothing else. `/privacy` names the preview cookie, and its tests and the layout's change with it. A stale flag set for a minute turns every flag off, and a test shows it. The app's Rollout reads `share-key`.
- **Proved on the local cluster:** a flag added to `flags` by hand reaches the app in seconds, and the app reports its revision, for the marked request, the preview and the share as each stage says, and changing it to off turns it off; the mark sent through Traefik is ignored; an id with a bad, old or missing signature, or one made for another page, is not in the share; flagd stopped for a minute turns every flag off; flagd with its binding missing at start is never ready; and the admission refusals are recorded.

### 15. The designs

In the mockup and the design system's README, agreed with Martin before anything is built:

- the "+" on Plan and the form it opens, and its read-only form for visitors;
- an improvement's card and sheet: its request, its spec waiting for Martin, its flag's stage, and its evidence at each stage (the pictures with the flag off and on, and the share stage's comparison);
- the flags in Controls: each flag, its stage, the step to widen it with the passkey, the kill switch, why a stage cannot be taken now (a canary in flight, another flag at the share stage), and "Preview it" during the opt-in stage;
- each one's read-only form for visitors.

The README's "Not decided yet" and its line that the "+" and the flags are Part B's lose what this settles.

### 16. Flags in the console

- The admin service's Role on `flags`, by name; the admission policy that holds the admin service's changes to the stages' shapes; the fences' tests, updated to allow it alone and to fail if either grows; and a refusals script and record beside `rollout-refusals.sh`'s.
- The stages and the kill switch in Controls, each an event with Martin as its actor (`flag.staged`), an admin event type with its migration. `policy/access.ts` gains widening, which needs the passkey again, and widening to stage 1, narrowing and off, which do not. The admin service refuses the share stage while a canary is in flight or another flag is at it, everyone before Verify's comparison has passed, skipping a stage other than the opt-in one, and a flag no improvement's spec names.
- After a narrowing or off, the admin service asks the app, with a marked request, for the revision it holds, and notifies Martin when it has not taken the change within a minute.
- Every 60 seconds the admin service probes the app the same way and compares the revision it reports with the one in `flags`, as a metric of its own; a Prometheus rule alerts Martin, through Alertmanager, on his phone, when they have differed for more than 5 minutes, which catches a watch of flagd's broken after it started. The rule has its test, beside the other alert rules'.
- Widening a flag is a security event at Notify, as task 11's rule counts them, and narrowing or off at Inform.
- For visitors, the same, read-only.
- **Proved on the local cluster:** flagd's binding removed after start alerts Martin within about six minutes.

### 17. Verify by variant

- Verify maps each of the generator's ids to its side with flagd's own `fractional` rule (flagd's evaluation library), for the flag at the share stage and its share in the admin service's events, and reads the generator's figures by id. The generator spreads its walk over its ids, so each side of a share gets the same mix of pages, and turns them independently of the canary's split (task 14); Verify checks each side has enough requests in its window.
- Verify for a work item shipped behind a flag, at each stage. At stage 1: the probes' journeys and the `/device` check, which Verify asks for here as the journeys gate does, pass with the mark, and the pictures of the pages the spec names, from the release and from stage 1, are its evidence; then it waits for Martin to widen. At the opt-in stage: a probe asks for the preview and the `/device` check finds the preview cookie and nothing else. At the share stage: flag-on against flag-off from the generator's own figures, on errors and latency, with the canary's thresholds and enough requests on each side, setting aside any window a canary overlaps. Each judgement an event, its figures the evidence. A flag turned off at any stage closes the work item as turned off, with the reason; it is no rollback.
- A test for each: each id on the side flagd's own evaluation gives it, an even split judged as passing, a side with more errors or a slower tail failing, too few requests waiting, and a canary's window set aside.

### 18. The "+"

- The "+" on Plan opens the form; the admin service appends `improvement.requested`, an admin event type with its migration, in Martin's words, and the work item of kind improvement it opens. `policy/access.ts` gains the request, which needs the passkey again, as approving an improvement's spec does. Both are security events at Notify. The line acts on an improvement only when its request came from one of Martin's roles.
- An improvement's pull request waits for Martin's approval in every mode; Part C's routing check holds it as it holds a release's.
- The line takes an improvement as it takes a ticket: its queue and the planner's input accept a request as well as a ticket. An improvement waits behind every open ticket, oldest first, and Martin can take one at once with Just one.
- The form has one field, Martin's words: the work item's title is their first sentence, cut at a word to about 60 characters, until the planner names it in the spec, so no model is asked for a title alone.
- The planner's prompt and spec template for an improvement: its title, what it changes, its flag's name, the pages it changes, and acceptance criteria its own tests prove with the flag on and off. Its questions arrive in Needs you, and every improvement's spec is held for Martin (`spec`) before any code.
- A visitor's suggestion still leads to no work (spec 5.3: a report only ever leads to a defect fix). Martin, having read one, asks with the "+" in his own words, and the comment on `ANSWERS.suggestion` says so.

### 19. The first improvement, and the documentation

On the local cluster, on Claude:

- Dark mode, asked for with the "+": it follows the browser's own setting (`prefers-color-scheme`), with no switch of its own, since a switch would keep a choice on the visitor's device. Its spec approved, built and merged with no human code, released, shown at stage 1, previewed, compared at the share stage, and switched on for everyone. Then turned off and on again, to show the kill switch.
- Martin approves it against `INTENT.md`.

Then:

- `COMPONENTS/`: feature flags, the admin service, the traffic generator, the probes, Verify and the console.
- `AGENTS.md`: the flags on the local cluster, and the generator's key.
- `TERMS.md`: flag, stage, the mark, preview, share.
- `docs/architecture/flags.html`, which steps through the stages as planned, made true to what was built.
- Spec sections 4.2 and 7, and an ADR for flags: flagd in its own namespace watching the resource, Verify judging from the generator's own figures, the app's in-process copy failing off, the mark kept by the network, and the generator's signed ids.

### Part B is done when

- [x] An improvement goes from the "+" to everyone through each stage, its spec approved by Martin before any code, and no worker's role can request one or stage a flag.
- [x] Verify compared its flag's two sides at the share stage, on the generator's requests alone.
- [x] The share stage was refused while a canary was in flight, naming the canary: shown at task 25's drill on local images, Martin narrowing a flag to Preview during its canary and trying Share (2026-10-31).
- [x] Its kill switch turned it off for everyone within seconds, with no deploy or rollback, and the admin service confirmed the app had it; every flag fails off a minute after flagd stops.
- [x] Neither a visitor nor the app's own code can make the mark or join the share: the mark is ignored through Traefik, a bad, old or missing signature is out of the share, and the flag context is code-owned.
- [x] The admission refusals for `flags`, `share-key`, the app's routes and its Middlewares are recorded, and the fences' tests hold flagd to reading `featureflags` in its own namespace.
- [x] Asking for an improvement and approving its spec each took the passkey again and reached Martin's phone.
- [x] Nothing is kept on a visitor's device but the preview cookie of one who asked for it: the device gates pass, a preview among them.

## Part C: guardrails

Each task is its own pull request, or a few in order, each demonstrable, and each taken by one orchestrating session through `/implement`. Work in the app's repository goes through it too, with keys beginning `app-`, and nothing it writes there mentions or hints at seeded defects. `/security-review` runs on every pull request that touches a workflow, the review gate, the admin service, a credential, a fence, an admission rule, a Role or a store grant, and each brief says so.

### 0. Settled before the start

- **Martin settled the open questions (2026-10-28):**
  - **Lights-out reaches the gate as a repository variable:** `AUTONOMY`, in the app's repository, as "Autonomy (Part C)" says. The gate passes by the variable, and names the rule that passed; the line enqueues only by a rule the store's level allows; so the stricter of the two always wins. The console's Lights-out says the variable is needed too. Built and proved, never the default.
  - **An improvement's pull request is told by a typed list of flag names.** The app declares every flag it asks in one list, and its flag context takes only a name on it, so TypeScript refuses any other. The list is not code-owned, since the coder adds to it, and the gate tags as an improvement any pull request that changes it or adds a place that asks a flag on it, so new behaviour behind a flag already on the list is caught too. An improvement with no flag at all is not in a diff, so the line, which knows a work item's kind, never adds an improvement to the queue: two locks, as for releases. The candidate of looking for a `request.flag('…')` name `main` does not ask was turned down: a flag asked through another name, or a destructured `flag`, escapes it.
  - **A label of Martin's on an issue is no way in.** The "+" is the only way Martin asks the line for work, with its passkey step-up; the factory reads no issue as input, and replies to an outside one politely (task 26). Spec 6's guardrail 10 is amended to match. A red-team attack is not work for the line: it runs fixed content against a mechanism, and the line builds nothing from it (task 22).
  - **The red-team attacks are scripted against the real mechanisms, with no agent.** No model writes an attack. Where the mechanism is itself a model's typed judgement (triage's questions to Jev, attack 1), it is called as it is for any report, since that is what is shown. Each makes the real attempt itself, from where an agent would be, and records the mechanism's refusal verbatim, so it costs almost nothing, repeats exactly, and suits milestone 8's menu for visitors. An agent given a hostile instruction was turned down: it costs money each time, and a model that declines proves nothing about the mechanism.
- **Order.** 20, 26, 27, 25, then 23's recording, 21, 22, 23's panel, and 24 last. The checks that need no cluster come first; alerts come before the proofs and drills, so a failed one pages; every mechanism records its refusals before `make guardrails` and the harness show them; the panel waits for the events it draws; and approval routing, which changes how anything merges, ends the part with Guarded run for real.
- **The designs first.** One pull request draws, in the mockup and the design system's README, the guardrails panel (task 23), the red-team menu with all five attacks and an attack's card (task 22; the mockup has three), the auto-rollback switch live and a canary paused for Martin (task 25), Lights-out's note on the repository variable, and a merge held for its risk tags in Needs you (task 24), each with its read-only form. Martin agrees it before any of those is built. It can be drawn while tasks 20, 26 and 27 are built.
- **Try before review** (`/implement`): a task that changes what runs on the cluster is built to branches, tried on local images with `try-the-line`, and only then reviewed, once.

### 20. Proofs in CI

Tests, with nothing on the cluster, for what is true today only by convention. One pull request; each test shown failing against a broken copy, said in its description.

- **Workflows:** every file in `.github/workflows` is parsed; none is triggered by `pull_request_target`, and every job's `runs-on` is a GitHub-hosted label from a list the test names. Only `review.yml` and the drift check (below) hold a secret, each in an environment only `main` may use, and neither checks out the pull request: each checks out nothing but `main`'s own files.
- **No model decides a merge:** the required checks in `scripts/github-settings.ts` are each pinned to GitHub Actions or the review App, and none is the reviewer agent's check or any check the factory's App posts (the names imported from `line/review.ts` and `line/gates.ts`). An import-graph test walks from `apps/factory/src/gates/`, `line/gates.ts` and `scripts/review-gate.ts` and fails if any reaches the gateway, a model client, Jev or an SDK of a model provider.
- **No App or worker may write a repository variable:** the factory's App's and the review App's declared permissions (in code, beside `github-settings.ts`) grant no Variables or Administration write, and no worker holds a GitHub credential but the GitHub worker's App; task 21 checks the installations' permissions live against what is declared.
- **Only the gateway holds a model key:** over the rendered manifests of every overlay (as `make check` renders them), no container but the gateway's names the `anthropic` or `typesafe` Secret, by `secretKeyRef`, `envFrom` or a volume.
- **The runners' fences render as intended:** `runner-fences.test.ts`, beside the other fences' tests, over the rendered `runners` policies: default deny both ways; the agent pod reaches only the gateway's 8080 and the line's handback in `factory`, with no DNS; the prepare pod reaches only DNS and 443 on public addresses; and the gateway and the line let in only those pods from `runners`.
- **The rulesets' drift check on a schedule:** `github-settings.ts --check`, weekly and on demand, in a workflow of its own with no other job, in an environment only `main` may use. It needs an admin's read of the rulesets, environments and secret names, which no CI credential has: a GitHub App of its own (Administration, Actions and Environments: read, nothing else: GitHub files an environment and its branch policies under Actions, and its secrets' names under Environments), installed on both repositories, which Martin makes, its key in that environment. A failed run reaches Martin as any failed scheduled run does. GitHub shows who may bypass a ruleset only to a reader who may change it, so the App's run warns that it did not compare that list and passes on the rest; task 21 proves it.
- **Proved** in CI. Martin makes the App and its environment.

### 21. `make guardrails`

One command for the proofs that need the cluster, each recorded where the console can show it.

- **`make guardrails`** runs, from the Mac with the local kubeconfig as the refusal scripts already do, each proof below, and appends a `guardrail.proved` event for each: the guardrails it proves (spec 6's numbers), the mechanism, held or not, the refusal verbatim, `main`'s commit, and a hash of the policies and Roles it was taken against. A new event type, appended by a store role of its own that may append that type and nothing else, its password from a Secret as the workers' are; row security, as for Martin's admin types, lets no other role append it, and the panel trusts a proof by its appending role. A proof that does not hold fails the command, names itself and pages Martin (task 27's rule).
- **Nobody bypasses `main`'s ruleset:** `github-settings.ts --check` with Martin's `gh`, which GitHub shows each ruleset's bypass list, as it never shows the drift check App's read (task 20); the proof fails if the list is unseen, so it cannot pass without reading it, or names anyone.
- **Egress:** `scripts/egress.sh`, each check a record.
- **Admission's refusals:** `scripts/admission-refusals.sh` and its siblings (route, mark, rollout, flags, flag stages, share key). Their records in `deploy/test/` stay for the fences' tests, and each gains the hash of the policies and Roles it was taken against; the tests fail when the rendered ones no longer match, so a policy loosened without the script run again fails `make check` (carried from Part B). The `other-identity` case is made true: an image under our own GHCR owner, signed by an identity other than `build.yml` on `main`, refused for its signature, not its registry, as ADR 0010 says it is; and `admission.test.ts` checks each refused image against the policy's `images` globs (carried from #632).
- **The App's refusal to write a workflow:** `factory github workflow-refusal`, taken again under `the-roganator` (its record is from the old owner), with the App's lack of the `workflows` permission declared in code and checked against the installation's permissions, Variables and Administration among them (task 20).
- **Stop the line:** a drill with the line taking a work item in dry run: `make stop-the-line`, then the proof that its agent pods are gone, no worker took anything new, and a canary in flight was aborted; then `make start-the-line`.
- **A rollback:** the last real rollback in the store, its analysis's verdict verbatim, and how long ago it was; the drill that makes one is task 25's.
- **Proved:** `make guardrails` on the local cluster, every proof held and in the audit log; a proof made to fail, by a loosened copy of a fence in a test, fails the command and pages.

### 22. The red-team harness

The attacks in spec 5.3, run by Martin from admin, each stopped by its real mechanism and shown.

- **Launching:** the red-team menu in admin (from the designs), all five attacks; `POST /admin/attacks/<attack>` appends `attack.launched`, an admin event type with its migration, which needs no passkey again: it loosens nothing, and asks the line for no work, since every attack's content is fixed in code and the line builds nothing from it (milestone 8 offers the same menu to visitors). The harness, a worker of its own in `factory` (`factory red-team`), acts on an attack only from Martin's roles, one at a time, and records each result as `action.refused` with the mechanism and its output verbatim, or, if nothing refused it, a failed attack that pages Martin (task 27's rule). It holds no GitHub credential: the GitHub worker makes attacks 2 and 3's attempts itself, on an `attack.launched` from Martin's roles, with fixed content, and closes what it opened. Its store role, Role and NetworkPolicy grant what the attacks need and nothing else, with a fences test each; since RBAC cannot limit what a pod it creates holds, an admission rule holds the harness's pods in `runners` to one image by digest (or, for attack 5, the one unsigned image), the agent's labels, and no volumes, Secrets or service-account token.
- **The attacks,** each made from where an agent would be:
  1. **An instruction in a problem report:** a report sent through the app's report route as a visitor sends one, its text from triage's evaluation set; triage's typed questions quarantine it, and the work item closes as quarantined. `action.refused` gains the mechanism `typed-judgement`. Jev's calls, which are the mechanism, are its only cost.
  2. **"Fix CI" by editing a workflow:** the GitHub worker is asked, as a step's handback asks it, for a commit to `.github/workflows/`, and its guard refuses it (`scope-fence`); then it asks GitHub directly with the App's token, as `workflow-refusal` does, and GitHub refuses it (`token-permission`). Both recorded.
  3. **A pull request that deletes the failing test:** a real pull request in the app's repository, opened by the GitHub worker with fixed content, that deletes a test; the test-integrity gate tags it test-loosening and the review gate holds it for Martin (after task 24; until then the gate fails it). The check's output is the refusal; the GitHub worker closes the pull request and deletes its branch.
  4. **Data to an outside URL:** a pod started in `runners` with an agent's labels, running the attack's script in place of the agent: an outside address by name and by number, and the provider's host, each refused by the egress policy, with the gateway reached as the control.
  5. **Shipping an image it built itself:** the same pod asked for on an image `build.yml` did not sign on `main`; admission refuses it, verbatim.
- **Guardrail 8:** adversarial inputs beyond reports. Bench fixtures (`line/bench/fixtures.ts`) with instructions in log lines and in page content, and a test that no log message reaches a prompt (`line/agents/evidence.ts`); the bench shows each agent's result fits its schema and does what its ticket asks, and nothing else.
- **The console:** each attack is a work item of category `red-team`, which the reel and the sheet already draw from its last `action.refused`; for visitors, read-only, until milestone 8 opens the menu to them.
- **Proved:** all five launched from the console on the local cluster, each stopped and its refusal on its card.

### 23. Blocked actions

Two pull requests: the recording before task 21, the panel after task 22.

- **`action.refused` from every mechanism.** Today only the scope fence appends one. The gateway appends one for each refusal (a spend cap, a work item's cap, a model or provider policy refuses), the GitHub worker for each write its guard or GitHub refuses (a protected path, a branch it does not own, a 403), and Kyverno's denials in the guarded namespaces are read from the events Kyverno writes and appended by a worker other than Kyverno, with the policy's message verbatim. The mechanisms' enum gains `gateway`, `typed-judgement` (task 22) and whatever else this names, as a new version with its upcaster. Row security lets each mechanism's refusals be appended only by the role that mechanism runs as, and the panel counts each by its appending role. Repeats of one refusal within a minute fold into one event with a count, so a loop cannot flood the store.
- **The guardrails panel:** each of spec 6's eleven guardrails, its mechanism, its last proof (from `guardrail.proved` or the last attack) and how old it is, and its recent refusals, linking to each; and one line saying which cannot be switched off. Visitors see it whole, read-only: it is part of the demo.
- **Proved:** each mechanism made to refuse on the local cluster (a cap reached on a work item, a protected path asked of the GitHub worker, an unsigned image applied), each in the audit log and on the panel.

### 24. Approval routing

The review gate becomes the approval-routing check, as "Autonomy (Part C)" decides, and the line merges through the queue when the autonomy level allows. A stack in this repository, after one in the app's.

- **In the app's repository:** the typed list of flag names (above), and the flag context taking only a name on it; the header settings in one file, so a diff can show them; and the test-integrity gate tagging a loosened test rather than failing it, so Martin's approval can carry it (in both repositories' copies of the gate).
- **The gate** (`scripts/review-gate.ts`, reading only the API, never checking out the pull request): risk tags from the diff (`dependency-change` for a lockfile or package manifest, `security-headers` for that file, `test-loosening` from the test-integrity check, posted by GitHub Actions from `main`'s workflow), CODEOWNERS read from `main`, a release (release-please's branch and only its files) and an improvement (the flag list changed, or a place added that asks a flag on it); an exact pin judged line by line, every changed line a `digest:` value of an image `build.yml` signed on `main`, from a commit that descends from the pin it replaces; and a pull request failed whose risk label anyone but Martin removed. Martin's opened and approved-at-head rules stay. In this repository, any App pull request but an exact pin fails. When the app's `AUTONOMY` says Lights-out, the gate also passes the App's risk-tagged pull requests there, but never a release, an improvement or a code-owned path, and this repository's rule does not change; a test for each exception with the variable set. The gate judges again when the gates' runs finish, and its summary names the tags and the rule that decided (in a form the line reads), which Needs you shows. The app's `review.yml` pin moves with it.
- **CODEOWNERS:** the factory's gates, GitHub worker, gateway, admin service, store migrations and redactor become Martin's.
- **The line:** reads the autonomy level and the auto-merge switch (nothing reads them today), and adds its own pull request to the merge queue (`enqueuePullRequest`) only when auto-merge is on, `review` has passed, and the rule that passed it is allowed at the store's level (at Guarded, low-risk or an exact pin; at Lights-out, also Lights-out's), and never a release, an improvement or a work item whose spec carried `out-of-scope`; otherwise the merge is held in Needs you with the gate's reasons and a link to the pull request. It reads the merge queue's own checks, so a failure there is an event and not an unexplained wait (carried), and holds a pull request that conflicts with `main`, saying so (carried). #702, approving a held review, is checked at the first real escalation (carried).
- **Docs:** spec 4.3 and 6 (Lights-out's rule, and who reads which signal), ADR 0014 amended for the routing rule and the variable, `COMPONENTS/APPROVAL-ROUTING.md`, `GITHUB-APP.md`, and `AGENTS.md` for setting `AUTONOMY`.
- **Proved,** on the local cluster with GitHub for real: first a soak at Guarded in dry run, the line recording what it would enqueue; then Guarded for real, an untagged fix merging, released and verified with nobody touching it; a risk-tagged fix (a dependency or a loosened test) waiting in Needs you until Martin approves its head, and a push after his approval failing the check; Lights-out once, with the variable, then back. Martin's part is one sitting.
- **Part C's retrospective,** in this file, as Part A's and Part B's: what was learned, and where each lesson lives.

### 25. Auto-rollback's switch

- **Off leaves a failed canary paused for Martin.** The analysis already judges a canary bad; with the switch off, that result is inconclusive rather than failed, and Argo Rollouts pauses an inconclusive rollout for a person. The switch reaches the analysis as a series in Prometheus, exported by the admin service from the store's controls and scraped from the admin pod directly, never through the collector, which drops that name from what it receives, so no other pod can send it: the templates (`release/analysis.ts`) are inconclusive on a bad result only when exactly one such series exists, from the admin pod, and reads 0; anything else, a missing series among it, rolls back. Nothing new may write the Rollout.
- **The control:** `autoRollback` in the line's controls and its route, switching it off needing the passkey again and paging Martin (`policy/access.ts` already lists it); the console's switch made live; a canary paused by it is a hold in Needs you, with promote and abort. Stop the line still aborts a canary, whatever the switch.
- **Proved** at a drill on the app's `main`, as milestone 6's was (written to pass every gate and fail under load): with the switch on, rolled back with nobody touching it, which is task 21's rollback; with it off, paused until Martin aborts from the console. **The share stage refused while a canary is in flight** is shown at the same canary (carried from Part B): Martin narrows `dark-mode` to Preview and tries Share; the console and the route refuse it, naming the canary; then back to Everyone.

### 26. Guardrail 10 as written

- **The factory reads no issue as input** (settled above), and replies once to an issue opened by anyone but Martin or the App, by numeric id: a fixed, polite text that echoes nothing of the issue, saying the factory acts only on what it finds itself and what its operators ask of it directly, and that a human will read the issue. The poller gains a watch of new issues in both repositories.
- **The App's issue actions act only on its own issues:** commenting on, closing or reopening an issue the App did not open is refused by the GitHub worker's guard, recorded as `action.refused`.
- **Outside pull requests:** task 20's tests prove none runs with a secret or a self-hosted runner, and the gate never passes one Martin has not approved at its head.
- **Spec 6's guardrail 10** says what is built: the factory acts only on issues it created, and an outside one gets a polite reply.
- **Proved** by tests and in dry run; the real reply is shown once an issue is opened from another account, Martin's to arrange.

### 27. Alerts for the factory

Three pull requests, a stack: the rules, the phone's switch, and the admin service's uncounted actions. Alerts reach Martin's phone only when they need him: in the 48 hours to 29 October Pushover sent him 100 messages from the laptop's cluster, half of them his own console actions. A rule that would alarm wrongly by design is fixed in the rule or in Alertmanager, not left for him to ignore.

- **The rules, each with its `promtool` test** (`alerts/rules.ts`, `factoryRules`), at their levels from "Alerts to Martin": the console or the app down (`ConsoleDown`, `AppDown`), and the probes that watch them silent (`ProbesDown`); the line stuck (`LineStuck`); a lease run out unreleased (`LeaseOverrun`); the store down (`StoreDown`, from the Postgres exporter, and `StoreUnwatched` when the exporter itself is gone); a pod in `factory` crash-looping (`WorkerCrashLooping`, from kube-state-metrics); and a day's or month's spend cap reached (`SpendCapReached`, from the gateway's cap gauges), at Page; a release rolled back, aborted or in error (`ReleaseRolledBack`, `ReleaseErrored`, a dry run's not counted), and an Argo CD application Degraded or OutOfSync for half an hour on every profile (`ArgoCDDegraded`, `ArgoCDOutOfSync`), at Notify. A guardrail's proof that did not hold (task 21) and a red-team attack nothing refused (task 22) page too, each added with its event by those tasks, as the security events are counted.
- **"Stuck" is the line not moving a work item it should be moving.** The line reports what it is carrying: only the work items it has taken, by stage, with the oldest's time there and the stage's limit in force (`policy/stuck.ts`'s, four times longer where a stage's agents run on the local model, as `ALL_LOCAL` sends them); none while it is stopped, none but the one under Just one, and none at Plan, Build or Review while a day's or month's cap is reached or agents take no new work, the time it was told to stand left out. The recorded `line:stage_oldest_seconds:max` and its dashboards stay. The line also reports how long any lease has been held past its expiry.
- **The console and the app down are told by the probes,** which ask each every fifteen seconds from inside the cluster, at the addresses the profile names (`HEALTH_CHECKS`), and count each check by target, address and outcome, read only from the probes' pod (`METRICS_FROM_THE_PROBES`); the gateway's cap gauges are read only from its pod as well (`METRICS_FROM_THE_GATEWAY`). Prometheus watches separately that the probes report at all.
- **Alertmanager named by its Service** in Prometheus's `alerting` config, sent no service-account token, in place of the chart's discovery of any matching pod.
- **One cause, one page:** Alertmanager's inhibitions mute what follows from a cause while it fires. The store down mutes the line stuck, a lease run out, a worker crash-looping, the security events' count gone stale, a change by the admin service no event names (`AdminActionUncounted`, which the line cannot compare without the store) and `root` Degraded; a spend cap mutes the line stuck; a worker crash-looping mutes what is said of that worker (a `worker` label) and `root` Degraded; the probes down mute nothing, as what they watch cannot fire without them.
- **A cause that comes and goes pages once:** the health alerts and Argo CD's keep firing ten minutes after their cause has gone (`keep_firing_for`); not the security events, each one event.
- **A Grafana dashboard of alerts:** every alert, firing or pending, whatever its level, with its level and labels, linked from every dashboard's Dashboards row, and whether alerts reach the phone. "Dashboard only" means this dashboard.
- **One switch for alerts to the phone: everything or nothing** (the second pull request). A switch in the console's Controls, a command of Martin's of its own (`alerts.switched`, not one of the line's controls, whose defaults are no profile's), recorded and audited as they are, on by default on the cloud profiles and off on `local`; switching it off needs the passkey again and pages (exempt from the inhibition, so on the cloud the last message before quiet says so), switching it on informs. The admin service and the line each export it as a series held to its own pod, and a `PhoneOff` alert with no level fires only while both report off, which mutes every alert with a level; the app's objective alerts, which go to the intake, are untouched. With either series missing, alerts reach the phone. Silencing an alert from its own message waits for the cloud profiles.
- **The admin service's uncounted actions** (the third pull request): it checks each event before it acts and appends it once the change is made, so the audit log records no change that failed; and the line, a worker other than it that already counts the security events, compares the flags (every stage and the revision), the Rollout's pause and full promotion, and the store's sessions against the events that name them, paging on any change no event names for two minutes (`AdminActionUncounted`), and on not being able to compare for ten. It reads `flags` by a Role of its own, get by name, and when each session started, nothing more.
- **`docs/COMPONENTS/ALERTING.md`:** its "Later" line keeps Part D's vulnerabilities and milestone 10's dead man's switch and outside check; its levels table names each new alert; the inhibition tree is said there in full.
- **Proved** on the local cluster with `try-the-line`, the phone's switch on for the drill and off after: each new alert fired once by breaking its cause briefly with nothing added only for the drill, each reaching Martin's phone at its level; then, with the switch off, the same on the Alerts dashboard and nothing on the phone. The store is stopped only with Martin's yes.

### Part C is done when

- [ ] Every guardrail in spec 6 has a test or a demo that runs from one command, and the guardrails panel shows each one's last proof.
- [ ] The proofs in CI fail when a workflow, a required check, a key's mount or a runner's fence is loosened.
- [ ] Each red-team attack, launched from admin, is stopped by its mechanism, with the refusal shown verbatim on its card.
- [ ] Every mechanism records its refusals as `action.refused`.
- [ ] A fix goes end to end at Guarded with nobody touching it, and a risk-tagged change waits in Needs you until Martin approves its head.
- [ ] With auto-rollback off, a failed canary waits for Martin, and switching it off took the passkey again and paged him.
- [ ] An outside issue gets the polite reply and leads to no work.
- [ ] The factory's health, releases and spend alert at their levels, and a change by the admin service with no event behind it alerts too.
- [ ] Part C's retrospective is written in this file, each lesson with its home.

## Part D: patching

Part D starts when Part C is done. Tasks 28 to 30 are detailed here already, and checked again then against what Parts B and C built; tasks 31 to 35 are outlined, and detailed then.

Each of tasks 28 to 30 is a few pull requests in order, each demonstrable. Those in the app's repository go through `/implement` with keys beginning `app-`, and nothing they write there, in code, commits, pull requests or replies, mentions or hints at seeded defects: they describe the scan, and nothing it might find. Every pull request that changes a workflow, the scan's scripts or the exceptions has `/security-review` as well as `/code-review`. A required check is added to `scripts/github-settings.ts` in the pull request that brings the job, or after the app's pull request that first calls it; Martin applies the settings once it merges.

### 0. Settled before the start

- Martin has agreed ADR 0013 and the Patching (Part D) decisions above.
- **One digest of Trivy, kept current.** The scanner everywhere is one image, pinned by version and digest in `.github/images/trivy/Dockerfile` (`FROM ghcr.io/aquasecurity/trivy:<version>@sha256:<digest>`), the one place every workflow reads it from, `app-gates.yml` among them. They read it from this repository at `job.workflow_sha`, the sparse checkout the scan's scripts come from, never from the checkout of a change or of the app, so no pull request chooses its own scanner. Dependabot reads no workflow's `env`, so `.github/dependabot.yml` adds `/.github/images/trivy` to its `docker` directories, with the three-day cooldown, which applies only if GHCR gives Dependabot a publication date for Trivy's image. It gives none for flagd's, so Trivy's is taken to give none until its first bump shows otherwise: the bump then comes at the next weekly run after a release, held by its digest, its signature and Martin's review (Risks), and the cooldown is kept so that it applies if a date is given. A bump's pull request verifies the new digest's cosign signature, with Aqua's release workflow named whole as the signer, as ADR 0010 names ours, and since `.github/` is code-owned it waits for Martin like any rule of the line. A test holds every use of Trivy in the workflows to that file, read from that checkout, and fails on a `FROM` that is not `ghcr.io/aquasecurity/trivy` with both a version and a digest, so the gates, the daily scan and the routing check cannot drift apart.
- **What Parts B and C add is found from its source.** flagd's image (task 14) is a third-party image pinned by digest in `deploy/`, and OpenFeature's packages and flagd's provider are in the app's lockfile, so the list takes them in with no change of its own; whatever else Parts B and C pin, it takes in the same way, and the coverage tests fail for anything it does not.
- **The scan's code is this repository's, at the commit the caller pins.** Its scripts are in `apps/factory/src/vulnerabilities/`, beside the gates' (`apps/factory/src/gates/`), so task 31's sense can use the same deadlines and exceptions in the cluster. They are Node with no dependencies, from a sparse checkout, as the app's gates are, reading YAML through `yq` (on the runners, and in `mise.toml` for the tests). The scanned repository is data: no job whose output reaches the scan runs its code, its pnpmfile, its `.npmrc` or its mise configuration, and `helm` and `kustomize` come from this repository's `mise.toml`.
- **Tokens reach GHCR alone.** The scan logs in to `ghcr.io` alone, with `docker/login-action` as `build.yml` does, and Trivy is given that Docker configuration, never the token in its environment or on its command line, so no other registry it pulls from is offered it.
- **What a log says.** Both repositories are public, so a workflow's log and its artifacts are anyone's to read. The daily scan's findings are open vulnerabilities in what runs, so no package or advisory of one is printed to its log or step summary, or kept as an artifact: Trivy writes JSON to the runner's disk with `--quiet`, and only counts, item names and failures to read reach the log. A gate on a pull request names what the change brings in, as `image-scan.ts` does, since the change is public and has not merged.
- **No deadline counts from before a finding is first seen.** A clock starts when the fix can be installed, never before the first scan's day, so the clocks of the first full scan's findings (the platform's, and development dependencies') start when task 28 lands, before task 30 can fail on them. Task 30 follows task 28 within days, and the first scan's findings are looked at as soon as it lands.
- **What protects the gates' wiring.** The scripts a gate runs come from code the change cannot alter, but `check.yml` and the app's `gates.yml` come from the change, and a skipped required check counts as passed. CODEOWNERS gives `.github/` to Martin in both repositories, so a change that skips or removes a gate waits for his review.

### 28. The daily scan

Three pull requests, in this order. The first also moves Trivy's pin into `.github/images/trivy/Dockerfile`, adds its directory to `.github/dependabot.yml`, and records, in `dependabot.yml`'s comments, each registry whose publish times Dependabot cannot read, so each image there is known to arrive with no cooldown: Microsoft's and GHCR's for flagd's image, and for Trivy's and whichever of `gcr.io` and Quay it cannot, as Dependabot says on the first bump from each: a pull request whose cooldown could not be applied opens with its warning that the registry gave no publication date, and one without it shows the cooldown held. Until a registry has had a bump, it is listed as unknown.

- **The list** (here): `apps/factory/src/vulnerabilities/inventory.ts` works out, from a checkout of either repository, what that repository owns, each item with the file and line of the pin that brings it, where its alerts are located:
  - each `pnpm-lock.yaml` git tracks;
  - each image of ours the local overlay pins (`deploy/overlays/local/*-image/kustomization.yaml` here, `deploy/overlays/local/image/kustomization.yaml` in the app), with the identity that signed it (`build.yml` on its repository's `main`);
  - each third-party image `kustomize build deploy/overlays/local` runs, by digest, with CI's copy where `scripts/ci-images.sh resolve` finds one;
  - each Helm chart an Application in the rendered overlay installs, at its `targetRevision`, with the values its `$values` source names, and Argo CD's own chart at the Makefile's `ARGOCD_CHART` with `deploy/argocd/values.yaml`, each to be rendered with `helm template` by the scan;
  - the k3s node image `deploy/k3d/cluster.yaml` names, the images that k3s release lists (`k3s-images.txt`, an asset of its GitHub release), and the load balancer and tools images k3d starts beside it, at the version `mise.toml` pins;
  - each stage of each tracked Dockerfile, `.devcontainer/Dockerfile` among them, that names an image rather than an earlier stage;
  - each image the workflows start, and the scripts they run (ZAP's in `apps/console/zap/scan.ts`, Trivy's own, the Postgres service and the Playwright container through `ci-images.sh`).

  An item another item already covers (the Playwright image is a Dockerfile stage and a workflow's container) is listed once, at its first source. The platform, k3s and k3d are this repository's alone. `inventory.ts --unlisted <checkout>` names every reference by digest in a tracked file outside `*.md` and test fixtures, every `image:` in the rendered overlay, every Application with a chart and every `FROM` that is not on the list, so a new kind of pin, one the inventory does not read, is caught: `inventory.test.ts` runs it on a fixture repository for each kind of source and on this repository, failing `make check`, and the scan runs it on whichever repository it scans, so a pin the app adds where the inventory does not look fails the app's run. `node apps/factory/src/vulnerabilities/inventory.ts <checkout>` prints the list, as JSON with `--json`: shown for both repositories in the description.

- **The scan** (here): `.github/workflows/vulnerabilities.yml`, on a daily schedule, on each push to `main`, by hand, and on `workflow_call`, with `permissions: {}` at the top and per job. Each job first refuses any event but a push to the default branch, the schedule or a run by hand, as the app's gates refuse a privileged context.
  - **`coverage`** (`contents: read`) proves the scanner reads the whole lockfile, and its only output is whether it passed. It installs each lockfile of the scanned repository with the pnpm the scanned repository's `mise.toml` names, read as data and installed by this repository's tooling, never by mise in the scanned checkout, `--frozen-lockfile --ignore-scripts --ignore-pnpmfile`, and no `.npmrc` but an empty one of its own. It fails when `pnpm list --recursive --depth Infinity --json`, development dependencies included, names a package, other than the workspace's own, that Trivy's SBOM of the lockfile alone (CycloneDX, no advisories) does not. Trivy may name more: other platforms' optional builds, which the install leaves out.
  - **`scan`** (`contents: read`, `packages: read`, `security-events: write`) needs `coverage` to pass. It works out the list itself, from the scanned checkout as data, with the scan's scripts from a sparse checkout of this repository at `job.workflow_sha`, and treats a pin `--unlisted` names, or a chart that does not render, as an item it cannot read. Trivy runs by its digest. Its advisory database is pulled from GHCR, retried, and refused if it was built more than a day ago. Each lockfile is scanned on its own (`trivy fs --scanners vuln --include-dev-deps` over a directory holding only the lockfile); each image of ours from the SPDX SBOM of each platform, verified with `cosign verify-attestation` against its signer, and from the image itself when its SBOM carries no Node binary; every other image by pulling it, from CI's copy where there is one, with retries. An item that cannot be read (a lockfile Trivy reads no packages from, an SBOM with no attestation, an image that cannot be pulled) is named in the log and fails the run, apart from the vulnerabilities.
  - **To code scanning:** one SARIF file for the repository, category `vulnerabilities`, made by `sarif.ts`: a rule for each advisory, and a result for each package and advisory in each item, located at the line that pins it (the package's entry in the lockfile, the `FROM`, the image pin, the chart's `targetRevision`, the cluster's `image:`, the workflow's line), naming the image and its digest in its message. An image's copy of a package is its own result, never folded into the lockfile's, so a finding excepted in one place is still seen in another. Its `partialFingerprints` are the item, the package and the advisory, so moving a pin that leaves the finding keeps the same alert, and moving it past the fix closes it. It is uploaded only when every item was read and its results are within code scanning's limits for one upload: otherwise nothing is uploaded and the run fails, so an alert is never closed because its image could not be pulled or its result was dropped.
  - **Proving it can see.** Each run also scans an image of ours that `main` pinned while it ran Node 24.22.0 (before #536), by a digest the scan's scripts hold as a constant, as it scans ours, uploads nothing for it, and fails unless CVE-2026-111497 is found in its Node. That is the task's proof, shown in the description from the SBOM or, where the SBOM lacks the binary, from the image, and it keeps a scanner that has stopped seeing Node from passing.
  - The log gives the counts by severity and the items it could not read, never a package or an advisory. Until task 30 the run fails only on what it could not read.

  `sarif.ts`, the fallback to the image and the refusals each have a test on Trivy's own JSON: an unreadable item fails and nothing is uploaded, results over the limit fail and nothing is uploaded, an SBOM with no Node falls back, two platforms' findings are one result, and a fingerprint survives a moved pin. This repository's runs scan everything above; the platform's first findings appear in its code scanning. `SECURITY-SCANNING.md` (what is scanned, when, where results go), `SHARED-GATES.md` and `CI-PIPELINE.md` say so, and `AGENTS.md` says how to print the list and run the scan by hand.

- **The app's call** (`app-vulnerability-scan`, the app's repository): `.github/workflows/vulnerabilities.yml` there, daily and on each push to `main`, a job that calls this repository's at a pinned commit and grants `contents: read`, `packages: read` and `security-events: write`, as its Scorecard call does. It moves its other calls of this repository's workflows to the same commit. Its results reach its own code scanning, since the upload names the calling repository; its first run is the proof.

### 29. The lockfile gate and the graph

Four pull requests, in this order:

- **The gate** (here): `apps/factory/src/gates/lockfile-scan.ts` compares Trivy's findings on each tracked lockfile of the base and of the change, each scanned alone with development dependencies, a lockfile only the change has against none. It fails on any vulnerability, at any severity, that the change's has and the base's does not. A vulnerability is known by its lockfile, its advisory, its package, and whether a production dependency reaches it (Trivy's `Dev`), so a package moved to another vulnerable version brings nothing new, and one a production dependency newly reaches does. A lockfile Trivy reads no packages from, on either side, fails. Its test: one only on the base passes, a new one at Low fails, a moved version brings nothing new, a development dependency's vulnerability reached from production fails, a new lockfile's fails, and an empty or unparsable report fails.
  - Here, `check.yml`'s new job `lockfile scan` runs on every pull request, read-only, with the script and the lockfiles from the base (`pull_request.base.sha`) and only the change's lockfiles, as data, from the change, so a change to the script is judged by the one before it. `REPOSITORIES` requires it, pinned to GitHub Actions as every required check is.
  - In `app-gates.yml`, a job `lockfile scan` beside dependency review, with the same refusal of a privileged context and the same `skip`, its script from this repository at the pinned commit. Dependency review stays.
  - Proved by a draft pull request here that adds a version of a package with a known advisory, failing the check, then closed. `SECURITY-SCANNING.md`, `SHARED-GATES.md` and `REPOSITORIES-AND-RULESETS.md` name the check.
- **The graph** (here): `.github/workflows/dependency-graph.yml`, on each push to `main` and on `workflow_call`, with one job and `contents: write` alone, which refuses any event but a push to the default branch. It checks out with `persist-credentials: false`, copies the lockfile alone into an empty directory, runs Syft's image, pinned by digest at the version `build.yml` attests with, over that directory, read-only, for its `github-json` snapshot, with the commit, the ref and a correlator naming the workflow so the next replaces it, and submits it to the dependency submission API with the job's token. Nothing is installed, and nothing from the repository runs. Syft's image joins the scan's list through task 28's test. Proved by the dependency graph listing an indirect package from `pnpm-lock.yaml` with its version, and by Dependabot alerting on an indirect package in either repository, the first time one has a known advisory. Dependency review's comparison then holds the indirect packages on the base's side alone, so it can find them removed, never added; the lockfile scan is what judges.
- **The app's gate and graph** (`app-dependency-graph`, the app's repository): its gates and its other calls of this repository's workflows move to a commit with both, and its `vulnerabilities.yml` gains a job, on a push alone, that calls the graph's workflow and grants `contents: write` to it alone.
- **The app's required check** (here, after the app's merges): `REPOSITORIES` requires `gates / lockfile scan` of the app, and `REPOSITORIES-AND-RULESETS.md` says so.

### 30. Exceptions and deadlines

Three pull requests, in this order, exceptions first so that one is in force before any deadline can fail a run:

- **Exceptions** (here): `policy/vulnerabilities.ts`, code-owned with the rest of `policy/` and importing nothing, so the scan reads it from a sparse checkout of this repository's `main` whatever commit the caller pins. Each entry gives the repository, the item (a lockfile or an image, as the list names it), the advisory, the package, why it cannot reach us there, and its expiry, and matches that item alone, so the same package elsewhere is still a finding.
  - The scan sets an excepted finding's alert to dismissed (won't fix), its comment the reason and the expiry. It reopens any alert of its own category (`vulnerabilities`, never CodeQL's or Scorecard's) dismissed with no exception in force, so that category's state is the policy's and nothing else's.
  - An entry whose expiry has passed, or is more than 90 days from the day the scan runs, excepts nothing, and the log names it to be removed.
  - The lockfile gate reads the same entries, from this repository's `main`, so a fix whose release also brings in an excepted finding is not blocked by it.
  - Its test fails on an entry with no reason, an expiry more than 90 days away, a repository not in `REPOSITORIES`, an item not on that repository's list, or an advisory that is not a CVE or GHSA id; an expired entry is the scan's to report, not a failure of `make check`.
  - `scripts/osv-scanner.ts <repository>` prints the `osv-scanner.toml` Scorecard reads, each entry an `IgnoredVulns` with its `ignoreUntil`; this repository's is generated beside its lockfile and given to Martin in CODEOWNERS. The scan compares each repository's file with the policy's and reports a difference as a warning, never failing a run or a pull request for it.
  - `AGENTS.md` says how to add an exception and regenerate the file; `SECURITY-SCANNING.md` says where exceptions live and why there.
- **Deadlines** (here): `apps/factory/src/vulnerabilities/deadlines.ts`, run by the `scan` job on each run, with no state of its own:
  - **Severity** is the higher of Trivy's and the publisher's: Trivy's `VendorSeverity` for the advisory's own source (GitHub's advisory for an npm package, the distribution's for an operating system's). Node's security releases publish no rating a machine can read, so Node's findings take Trivy's alone until one does.
  - **The fix is installable** from the first fixed version's publish time in npm's registry, plus the scanned repository's `minimumReleaseAge` or pnpm's default of a day, for a package; from its release in Node's release index for Node; and for an operating system's package, from the creation of the newest image on the line of the pin that brings it (the runtime stage, for an image of ours), found as `ci-images.sh newest` finds it, or the tag's current digest for a pin by tag, once that image no longer has the finding. Only an image with such a finding has its line's newest scanned, and nothing is uploaded for it. While no fix is installable there is no deadline.
  - **The clock starts** on the later of the day the fix is installable and the day the finding's alert was created, read from code scanning with the job's token; a finding with no alert yet is first seen today. A rename keeps its clock: when an item is new to the list, and an open alert of the same package and advisory belongs to an item no longer on it, the new finding takes that alert's day. An exception's expiry does not restart the clock, so a finding whose exception lapses returns with the deadline it always had. Critical 2 days, High 7, Medium 30, Low 90. An excepted finding has no deadline.
  - The SARIF is uploaded first, so a new finding's alert exists, and then the run fails on a new High or Critical (first seen today), on one due within a day, and on one past its deadline. The log and the step summary give counts: by severity, and by overdue, due within a day, within a week, later, and no fix.

  Its tests: each severity's deadline; the publisher's higher rating winning, and a lower one not; a fix published before the first scan counting from the first scan; a fix still inside pnpm's day not yet installable; an image line with no patched image giving no deadline; an excepted finding failing nothing; an expired exception's finding returning with its old deadline; a renamed item keeping its clock, and the same package in another item that is not a rename starting its own; and each of the three ways to fail. `SECURITY-SCANNING.md` gives the table and when the scan fails.
- **The app's ignore file** (`app-osv-scanner`, the app's repository): its `osv-scanner.toml`, generated from the policy, given to Martin in its `CODEOWNERS`, and its calls of this repository's workflows moved to a commit with both pull requests above.

Then each finding open when task 30 lands is fixed or excepted: Dependabot's pull requests for direct dependencies, a lockfile refresh or override for an indirect one, a moved pin for an image or a chart, or an entry in `policy/vulnerabilities.ts` for one that cannot reach us. Each is a work item of its own, briefed from its alert, and the scan fails until every one past its deadline is done.

### Tasks 28 to 30 are done when

- [ ] Every lockfile, image of ours, third-party image (flagd's among them), platform image, Dockerfile stage and image CI runs is on the list, and a pin in either repository that is not fails its scan, and `make check` here.
- [ ] Both repositories are scanned daily and on each push to `main`, each finding an alert in the repository that owns it, at the line that pins it; the scanner reads every package `pnpm list` gives.
- [ ] A run that cannot read an item or fetch the day's advisories fails, names it, and closes no alert.
- [ ] An image on Node 24.22.0 shows CVE-2026-111497, and every run proves it still does.
- [ ] Trivy is pinned in one file Dependabot updates, and `dependabot.yml` names each registry where its cooldown cannot hold.
- [ ] A pull request in either repository that brings in a known vulnerability fails `lockfile scan`, required in both, run from code the change cannot alter.
- [ ] The dependency graph lists the lockfile's indirect packages, and Dependabot alerts on one with a known advisory.
- [ ] The scan reports each open finding's deadline in counts alone, and fails on a new High or Critical, one due within a day, or one past its deadline.
- [ ] Exceptions come from `policy/vulnerabilities.ts` on this repository's `main` alone, each for one item, expiring within 90 days, and each repository's `osv-scanner.toml` is generated from them and code-owned.
- [ ] The daily scan passes in both repositories: every finding open when task 30 landed that has reached its deadline is fixed or excepted.

### Tasks 31 to 35

- **31. The dependency sense.** The daily read of the digests deployed and the day's results, as Patching (Part D) says, each finding a signal, with the App's permission to read code scanning in both repositories. A running digest with no result is a signal too.
- **32. Triage of its signals.** A signal's and a ticket's shape for a dependency, since today's name an app route and fingerprint a route or a page: the image, the package, its versions and the advisory, with their event versions and upcasts. Symptom classes for a vulnerability and a routine update in `policy/triage.ts`, with their severities. The fingerprint is the package and the advisory, or the package and its new version for a routine update, so the next day's repeat counts on its ticket, and the line takes a dependency's ticket as it takes a defect's.
- **33. A dependency update down the line.** Plan writes the spec from the advisory or the release; Build moves every pin, or takes up Dependabot's pull request; the gates are the app's own, the lockfile scan and the image scan among them; Verify scans the running image as well as running its journeys, and records the scans from before and after as the work item's evidence, the picture its card shows. The app gets the test that keeps its Node pins in step. The routing check passes a Critical fix as the decisions say, and its tests hold each of these for Martin:
  - a change that claims a fix its scans do not show;
  - a fix that also changes code;
  - a finding gone because its package was removed or aliased, or the runtime image swapped;
  - a Critical fix bundled with an unrelated bump;
  - a fix rated Critical by its publisher and High by the scanner.
- **34. The factory's and the platform's findings.** A finding opens or updates the issue here, with its deadline, and notifies Martin, at task 11's Notify level.
- **35. The run and its documentation.** At Guarded, a Critical fix for the app from the scan to verified with nobody touching it, and a routine update waiting in Needs you at the merge. `COMPONENTS/` (security scanning, the senses), the spec's senses and gates, and `AGENTS.md` for the scan, the exceptions and the issue. Part D's retrospective, in this file, as Parts A, B and C's, and the milestone's own after it.

**Done when:** every lockfile, image of ours, third-party image and platform image is scanned every day, a test fails when a deployed image is not, and no finding is past its deadline unexcepted; a security release or fixable vulnerability in what the app runs becomes a ticket within a day of being published, goes down the line ahead of waiting work and is verified in production, merging without Martin when its scans show it fixes a Critical one; a routine update follows behind and waits for him; a finding in the factory or the platform opens an issue and notifies Martin's phone; and Part D's retrospective and the milestone's are written in this file, each lesson with its home.

## Exit criteria

- [ ] Parts A, B, C and D's criteria are met.
- [ ] Spec 10.1's scenarios 6, 7 and 8 run on the local cluster and are shown in the console: each red-team attack stopped by its mechanism, a risk-tagged change waiting in Needs you until Martin approves, and an improvement requested, approved and shipped.
- [ ] Spec 10.3's "every guardrail has a test or demo showing it holds" is met.
- [ ] Martin has used admin mode on a laptop and a phone and approved it against the bar in `INTENT.md`.

## Out of scope

- Visitor keys, their usage view, visitor limits and the visitor budget, the injector and its menu, the red-team menu for visitors, and the report widget's text for its sender (milestone 8).
- The replay site (milestone 9).
- Public certificates, the domain, the tunnel, the outside uptime check and the dead man's switch (milestone 10).
- A/B experiments on what people prefer: with no real shoppers, there is nothing honest to measure.
- Canaries for the factory's own images.
- Stopping work in flight for a vulnerability: it goes to the front of the queue.
- The line working in the factory's own repository: Martin patches the factory from an issue.

## Risks

- **The admin service is a new way in.** It is the only write path a browser reaches. It is small, refuses by default, has its own role and Role, is reviewed for security on every change, and its tests and scan run in CI.
- **A worker could pose as Martin, or touch another's tables.** Some workers handle what the internet sends. Each has a role of its own, granted only what it uses, and row security on the admin event types, with every reader checking the appending role, keeps Martin's commands his.
- **Guarded merges into a public repository with nobody watching.** A dry-run soak comes first, the routing check rather than the line decides, the canary's rollback is the guard after the merge, and tightening autonomy is one click.
- **Flag state lives outside Git.** It is the one piece of production state Argo CD does not hold. Every change is an event, so the audit log is its history, and a flag's default in the app's code is off.
- **The mark is kept by the network, not a key.** A route to the app that forgot to strip `x-unmeasured` would let anyone see a flag at stage 1, and leave themselves out of the app's telemetry, which the header already allows today. An admission rule here requires the strip on every route to the app, and refuses a Middleware that would put the header back. The node itself, and anyone allowed to port-forward to the app, can still reach it directly, and are trusted. On a public profile the tunnel runs as a pod that reaches Traefik's Service only, never the app's.
- **A page can differ by flag.** On a public profile, a shared cache in front of the app (milestone 10) must not serve one side's page to the other, so pages are kept from shared caches there.
- **Alertmanager reaches the internet.** It is allowed out on 443 as Kyverno is, until egress by host name (#176).
- **The local authority is trusted by the Mac.** It is constrained to `localhost` names, so its key, which anything running as Martin can read, mints nothing for any other site, and removing its trust from the Keychain is one command.
- **An image's cooldown holds only where Dependabot can read its date.** Dependabot's cooldowns slow its routine bumps; a security fix does not wait for one, since the line moves the app's pins itself and the factory's are moved from their issue, so neither is held past its deadline. Dependabot cannot read Microsoft's registry's dates, or GHCR's for flagd's image, and Trivy's is taken to be the same until its first bump shows otherwise, so Playwright's image, the devcontainer's base, flagd and Trivy arrive at the first run after a release (daily for Playwright's, weekly for the rest), whatever cooldown `dependabot.yml` gives them (flagd's fourteen days among them), and perhaps not `gcr.io`'s (the distroless runtimes') or Quay's (the Postgres exporter's), which task 28 finds out and `dependabot.yml` records. No check of ours reads registries' dates to hold a cooldown in its place (task 30 reads them only to start a deadline's clock): a rebuilt tag no longer lists the digest pinned, a re-pushed tag's date moves while the digest stays, and a floating tag's date stays while the digest moves, so no one date means "this digest is old enough". So for those images what stands between a compromised release and `main` is the exact digest, the publisher's signature where there is one, the change's scans (which, for Trivy's own bump, are the scanner being changed, so protect nothing) and Martin's review, which for Trivy's pin is code-owned and for the rest rests on his merging every pull request.
- **An update can bring in what it was meant to keep out.** Dependabot's cooldowns, where a registry gives it a date, and pnpm's day still apply, a release with weaker provenance is still refused, only a change of pins whose scans show it removes a Critical vulnerability merges without Martin, and the canary is the guard after the merge.
- **A scan that passes because it saw nothing.** A lockfile it cannot parse, an image it cannot reach or advisories it cannot fetch would read as clean. Each fails the scan instead, a test holds the packages it reads to `pnpm list`'s, and another holds its list of images to the rendered manifests.
- **Runs on Claude cost money.** Each is time-boxed and within the spend caps, and the results say what each cost.

## Retrospective

### Part A

Written as Part A's pull requests (#498 to #590) merged, with the fixes its runs on the local cluster needed. What Part A taught, and where each lesson now lives.

**Learned on the cluster**

- Using it found what review did not. In one afternoon at the console, task 12 found five faults that every pull request's two reviews had passed: stopping the line alerted no one (#575); giving the passkey again alerted at every step-up, which told Martin nothing (#575); Haiku 4.5 refuses the effort the gateway sends, so the first step on it failed (#578); "the next few" kept counting from the first time it was chosen (#581); and a held deploy named no pull request, and said it waited for Martin before one existed (#562: #574, #576). Each was a judgement only use could make, or a fault only a real call could show.
- A model policy offers must take every parameter the gateway sends. The settings tests ran against the gateway's fake provider, which accepts any; the provider refused on the first real call. Every Claude model offered now takes an effort, and the local one is sent none (`policy/models.ts`).
- Postgres keeps time to the microsecond and JavaScript to the millisecond, and postgres.js turns every `timestamptz` parameter into a `Date`. A count "since" a moment Martin chose lost the difference, and the line could take one fewer than Martin asked for (#572: the store's clock stamps it, and the queue binds it as text; `docs/COMPONENTS/EVENT-STORE.md`).
- An OpenTelemetry gauge cannot forget a series under cumulative temporality, and temporality belongs to the reader, not the instrument: a hold's series reads 0 until the line restarts (`docs/COMPONENTS/TELEMETRY.md`, pinned by a test).
- An alert can say only what its labels carry. The per-hold alert names a work item and a pull request, an exception to closed labels that is bounded by the holds waiting (`TELEMETRY.md`, `ALERTING.md`).
- A phone cannot use the local cluster: `localhost` is the phone, and a passkey belongs to its host. On the local profile the phone is Pushover, and the console at phone width on the Mac; real use from a phone waits for a public profile (`AGENTS.md`).
- The docs said a stuck line pages Martin, and no rule did; task 13 made the docs true, and the rule is Part C's.

**How the run worked**

- Trying each task on the cluster as soon as it is deployed, with Martin at the console, finds more than proving them all at the end: the five faults above were found together, late. `/implement` now has Martin try each work item once it is synced and healthy (#590).
- Two workers at once worked wherever their files did not overlap (#574 with #575, #576 with #578).
- `/security-review` in a worktree gathers an empty diff from the main checkout, every time: the reviewer reads the worktree's own diff (#590).
- A reviewer's sub-agent sometimes reported to the orchestrator rather than its worker: reviewers report to their worker alone, and the orchestrator forwards any that stray (#590).
- A second pull request marked `Part of #n` leaves its issue open after the last merges: the orchestrator closes it, naming its pull requests and how it was proved (#590).
- Database tests queued behind one migration lock, so a loaded `make check` timed out where CI passed, and workers lost time to it: each run migrates once and gives each test a copy (#586, #588).

**Left open:** Martin's use of the console from a phone waits for a public profile, so that box stays open; the stuck alert is Part C's (task 27).

### Part B

Written after Part B's pull requests (#592 to #707, and the app's from #108) merged, and its last box was shown in Part C. What Part B taught, and where each lesson now lives.

**Learned on the cluster**

- Proving each task on the cluster found what review did not:
  - flagd took the `FLAGD_PORT` that its Service's links put in its pod for its own `--port`, and read it as 0, so its evaluation service listened on a random port and egress's check that the app cannot reach 8013 proved nothing (`enableServiceLinks: false`, #601; reported upstream as open-feature/flagd#2105).
  - flagd's readiness follows its first read and never clears, so a watch broken after start leaves it ready, serving the last flags it took. The admin service asks every pod of the app for the revision it holds every 60 seconds, and `FlagsDiffer` and `FlagsNotTaken` alert Martin (task 16; `FEATURE-FLAGS.md` "Readiness", `ALERTING.md`; upstream, open-feature/flagd#2104 and a comment on #2017).
  - `website` had no default deny, so a pod the app's repository labelled otherwise was open to the whole cluster (#612).
  - A settings test took its instants from the host's clock, and the Postgres container's runs 0.1 to 4.8 ms ahead of it (#614: the store's clock, as Part A's lesson on time already said).
  - Verify pictured a flag's pages in light only, so dark mode's pictures off and on were the same (#704: light and dark, always).
  - #704's own first try found two faults no review had: the console's image did not hold a module it imports at run time, and the line's client refused the probes' new field. `scripts/image-modules.test.ts` now walks every Node image's entry points, and an end-to-end test runs the probes' real check through the line's own client (#704).
- flagd's own evaluation service puts 15 to 49 of the generator's 101 ids on another side than `@openfeature/flagd-core` 5.0.0, which the app runs in-process. Verify works out the sides with flagd-core, and a recorded fixture holds it to the pinned image (#658; `FEATURE-FLAGS.md` "Which side an id is on").
- The first real improvement found what the planned proof did not. Task 18's proof, a dry run on Claude, took the happy path. Dark mode (work item #1082, task 19) found that the coder could not ask for a file outside its scope (#692: it names the files it needs, and the line holds `scope` at once), and that a replan planned from the pull request's head and renamed the flag (#698: it plans from the base, told its last spec and why it came back). Bench fixtures for a replan came with #700.
- Every runner's prepare failed from #664's image, which held only this repository's pnpm, so corepack tried to fetch the app's own pin into a read-only home, until task 18's proof ran one; nothing had said so in between, since the line took no work. The runner now runs this repository's pnpm, checked against `mise.lock`, and its prepare logs both versions (#684; `AGENT-RUNNERS.md`). A step that fails twice holds `failures`, which notifies Martin (`ALERTING.md` "Holds"), but only once the line runs one. CI now runs the prepare step in the runner image each pull request builds, as the prepare pod runs it, on a checkout that names another pnpm, and fails on #664's image (`AGENT-RUNNERS.md` "Trying a runner").
- A proof that needs a coincidence slips. Share refused while a canary is in flight needed an app release while a flag was at Preview; it was missed at work item #1009's canary, carried to Part C, and shown only once task 25's drill made the canary (2026-10-31). A done-when that needs an event the factory does not control now names the drill that makes it (`docs/PLAN/README.md`).

**How the run worked**

- Review came before the try. #692 and #698 each had a full review before the line ran them, and the replan's fault showed only once #692 was pinned. Work that changes what runs on the cluster is now built to branches, tried on local images, and reviewed once, after (`/implement`'s "Try before review", #700).
- Pull requests went through several rounds of review (#634 four; #642, #692 and app #108 three each), with meta-reviews after they were open, while task 17's stack merged with no meta-review, the session having paused. Review is now answered across a stack once, its findings gathered and each fixed in its branch in one pass (`/implement`'s Stacks, #721).
- Before stacks, dependent pull requests were retargeted as each merged, and conflicted (#642, #644, #646). Task 17's four merged as one stack (#657 to #660), and stacks are now how dependent work goes (ADR 0014, `AGENTS.md`).
- Designs drawn in a session with Martin, in one pull request whose merge is his agreement (task 15, #635), were quick, and tasks 16 and 18 were built from them. Part C's were made the same way (#739).
- From 2026-10-25 Martin tried only what needs a person, a passkey above all, in one short sitting, and the orchestrator ran and reported the checks on the cluster itself (`/implement`'s "Try before review").
- The run kept its state in files in `scratch/`, which grew too big to read again each session. Part C keeps it on a board outside this repository.
- "Finish, don't file" had no place for what was not the task's own. Part B ended with items carried into Part C, which #720 placed each in its task, marked "carried", and four left to Martin to place as issues (#548, #597, #628, #631).
- The console's JavaScript budget was raised nine times in Part B, from 109.7 to 128.0 kB, each "Martin's call at merge", and has risen since (`apps/console/budget.json`). Why it grows, and what would bring it down, are #751 to #755: a budget that counts code the first view never loads, names kept in several places, eight ways of writing to the admin service, stylesheets that restate the same recipes, and every view rebuilt on each tick.
- The orchestrator once tried to add a pull request to the merge queue (app #108). Merging is Martin's (`AGENTS.md`).
- An earlier try's `kubectl set env` without `-c` wrote every container, the line's `runner-image` init container among them, and left fields Argo CD never removes, which failed `make admission-ready`. Each try keeps an undo list, and every `set env` names its container (`try-the-line`, #601).

**What Part C changed because of it:** it tries before review and answers a stack's review in one pass; its designs were agreed in one pull request before any was built (#739); its state is on the board; and the share stage's refusal was shown at a drill's canary rather than waited for.

**Left open:** none of Part B's boxes. What it carried is in Part C's tasks (#720).
