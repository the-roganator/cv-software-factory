# Feature flags

Ship improvements switched off; a kill switch without a rollback. Part of the [runtime plane](README.md#runtime-plane).

An improvement Martin asks for is planned behind a flag its spec names. Its change is built, reviewed and merged as a fix's is, and once its release is promoted the line hands it over, off ([an improvement](ORCHESTRATOR.md#an-improvement)). From then on Martin widens its flag a stage at a time, and Verify judges each stage ([Verify by variant](RELEASE-AND-VERIFY.md#verify-by-variant)).

- **v1:** OpenFeature with flagd ([ADR 0015](../architecture/adr/0015-feature-flags.md)). [How an improvement goes out](../architecture/flags.html), stage by stage, is drawn as an explainer.

## An improvement, end to end

Each step is on the page that does it:

1. **Asked for.** Martin asks with the "+" on Plan, in his own words, giving his passkey again; it reaches his phone ([admin service](ADMIN-SERVICE.md#an-improvement)). The work item is of kind improvement, and waits behind every open ticket ([an improvement](ORCHESTRATOR.md#an-improvement)), unless he takes it with Just one.
2. **Its spec, held.** The planner names its title, a flag of its own, the pages it changes, and criteria with the flag on and off ([an improvement's spec](PLANNER.md#an-improvements-spec)). Every spec of an improvement is held for Martin (`spec`) before any code, and approving it takes his passkey again.
3. **Built behind the flag.** The coder writes each criterion's test with the flag on or off, and every new behaviour behind `await request.flag('<flag>')` ([coder](CODER.md#its-prompt)). A file it needs outside the scope holds the work item as `scope`, as for a fix ([holds](ORCHESTRATOR.md#holds-and-martins-answers)).
4. **Reviewed.** The reviewer holds the spec to Martin's request and the change to its flag ([reviewer](REVIEWER.md#what-it-holds-the-change-to)). Approving a held review answers and resolves its open threads as his acceptance.
5. **Its merge waits for Martin,** in every autonomy mode; then it is released through a canary as a fix is, switched off.
6. **Handed over** once its release is promoted: its row on the line ends, its issue says the change is in, off, and the work item stays open for its flag ([an improvement](ORCHESTRATOR.md#an-improvement)).
7. **Staged by Martin, judged by Verify.** With the flag off, Verify has the probes picture its pages in light and in dark, as a baseline. At Checks the probes run again with the flag on, and Martin sees each page off and on; at Preview a probe asks for the preview, and the rest run with its cookie, which must be all they keep; at Share, Verify compares the flag's two sides on the traffic generator's requests ([Verify by variant](RELEASE-AND-VERIFY.md#verify-by-variant)). Each stage waits for the check before it.
8. **Closed.** Everyone closes the work item as verified; Off, at any stage below it, closes it as turned off, with no rollback. Off stays the kill switch after Everyone, and closes nothing more ([the stages](#the-stages)).

## Where it runs

- **flagd 0.18, alone in `flagd`,** not in the app's pod or beside it in `website` (`deploy/base/flagd`). The app's pods hold no token and no route to the Kubernetes API, and nothing the app's repository may write in `website` can touch flagd, its service account or its state.
- **The state of every flag is one `FeatureFlag`, `flags` in `flagd`,** which flagd watches through the Kubernetes API. Only the kind's definition is installed, vendored from OpenFeature's operator at the API version flagd builds against, not the operator itself. In Git it has no flags. Argo CD makes it before flagd starts, and leaves its flags alone ([GitOps](GITOPS.md#syncing)).
- **flagd reads `flags`, and writes nothing.** Its watch selects `flags` by name, so its Role may get, list and watch that one FeatureFlag, by name, and no other. Admission keeps `flags` the only one there all the same and refuses its deletion, since flagd keeps serving the last flags it read when its resource goes ([admission control](ADMISSION-CONTROL.md#flags)). Of ours, only the admin service writes `flags`, Martin's [stages](#the-stages).
- **The app's pods reach flagd's sync port (8015), and nothing else of it** ([network policies](NETWORK-POLICIES.md#flagd)): its [flag context](#the-apps-flag-context) streams the flag set from it and evaluates each request itself. Not flagd's management port (8014), where the kubelet checks its health from the node. flagd reaches the Kubernetes API, DNS and the collector, where its traces and metrics go; its logs are its container's.
- **Its image is admitted by digest** in a copy of admission control of its own, `flagd-images`, so `website-images` still admits no third-party image.

## The stages

Martin stages each flag from the console's Flags panel, a slider of the stages per flag ([console](CONSOLE.md#what-it-draws)), and the [admin service](ADMIN-SERVICE.md#the-flags-stages) writes his stages into `flags`. It writes typed stages, never flagd's own JSON: `policy/flags.ts` renders them, and nothing else. Each stage keeps the ones before it, and is a fixed shape of flagd's targeting over the [evaluation context](#the-evaluation-context); the share is the only parameter. A feature is `ENABLED`, with two variants, `on` (`true`) and `off` (`false`):

| Stage | Default | On, by its targeting, for |
|---|---|---|
| Off | `off` | Nobody: no targeting. Off is a change to the flag, never its deletion |
| Checks | `off` | A request with `marked` |
| Preview | `off` | Those, and a request whose `preview` names the flag |
| Share | `off` | Those, and a request with `signed`, by flagd's `fractional` rule over its `targetingKey`, with `on` weighted by the share, 10, 25 or 50, and `off` by the rest |
| Everyone | `on` | Everyone: no targeting |

A flag `flags` does not name is off, by its default in the app. Beside the features, every write sets the [revision](#the-revision) anew: `flag-set-revision`, with one variant, `revision`, whose value is the revision, and its default.

- **Only the admin service writes them.** Its service account holds one Role in `flagd` (`deploy/base/flagd/admin-stages-flags.yaml`): get `flags`, and update it, by name, and nothing else. It writes the whole spec, rendered from every flag's stage, conditional on the resourceVersion it read. flagd's own Role stays read-only, and so does the line's (`deploy/base/flagd/line-reads-flags.yaml`): get `flags`, by name, to compare each flag's stage and the revision with Martin's moves, and page him when a change stands that none records ([alerting](ALERTING.md#changes-no-event-records)).
- **Admission holds it to the shapes.** A Role names objects, not fields, so `flagd-flag-stages` refuses any change of the admin service's to `flags` in which a flag is not a feature, named as the app names them, at one of these stages, or the revision in its one shape, never `none`, `stale` or `invalid`; and any change to the rest of `flags` ([admission control](ADMISSION-CONTROL.md#the-admin-services-hold-on-flags)). So the service, or anyone holding its token, can stage a flag and nothing more: no other variable of the request, no other value, no other share.
- **Which stage may follow which is the service's,** not admission's: `policy/flag-moves.ts`, which the console draws its slider from too. Widening one stage at a time but Preview, which may be skipped; to Checks only once Verify has a run of the improvement with the flag off to compare with, its pages pictured in light and in dark; past Checks only once Verify's check there with the probes has passed, and past Preview only once its check there has (`flag.checked`: the journeys and the `/device` check with the flag on, against a run with it off), so each stage is checked before the flag goes past it; Share only between canaries and for one flag at a time; Everyone only once Verify's comparison at Share has passed (`flag.compared`), or straight back for a flag turned off from Everyone; narrowing and Off at any time. Off closes the improvement's work item as turned off, and its issue as not planned ([Verify by variant](RELEASE-AND-VERIFY.md#off)), and so the flag stays off on that work item, but for going straight back to Everyone. Everyone closes it as verified, and its issue as completed, once the app has had a minute to hold the move ([Everyone](RELEASE-AND-VERIFY.md#everyone)); the flag stays Martin's, and turning it off then closes nothing more. Off to Checks asks for no passkey; every other widening does. Each move is `flag.staged`, one of [Martin's commands](EVENT-STORE.md#martins-commands), on the work item whose improvement's spec names the flag ([the admin service](ADMIN-SERVICE.md#the-flags-stages)).
- **Argo CD and an administrator are not held.** Argo CD makes `flags` and leaves its flags alone; an administrator may still write them by hand, as `flagd-flags` allows.

## Readiness

flagd reads `flags` before it serves anything, and exits if it cannot: with the resource missing, its Role or binding missing, or the API out of reach, it restarts until it can, and is never ready. A first flag set it refuses leaves it unready. Once ready it stays ready: at 0.18 its readiness follows its first read, not its watch, which it retries for ever when broken, while it serves the last flags it took. A watch broken after start is caught from outside instead, once `flags` changes and the app does not follow: every 60 seconds the [admin service](ADMIN-SERVICE.md#whether-the-app-holds-the-flags) asks each of the app's pods, at its own address, with a marked request, for the [revision](#the-revision) it holds (`x-flags-revision`), and compares it with the one in `flags`. Martin is notified when they have differed for more than 5 minutes, and paged when a narrowing or Off has not reached the app within a minute ([alerting](ALERTING.md#the-flags-the-app-holds)). While nothing changes, a broken watch serves the flags as set, and nothing is missed. The check believes what the app says it holds, which its flag context, code-owned in the app's repository, tells: it catches flagd's watch failing, not an app that lies.

## The app's flag context

The app asks whether a flag is on through one module, its flag context (`src/flags/` in the app's repository), the only code there that may import OpenFeature or flagd's provider. The provider runs in-process: it streams the flag set from flagd's sync port and evaluates each request in the app, so no request waits on flagd. The module is code-owned in the app's repository, since it decides who is a check, a previewer or in a share. What the factory reads of it, and writes for it, is the contract below: the context's names, which the admin service's stages target; the revision, which it asks every pod for; and the variant on a request's span, to read a trace by. Verify does not read it: it works out a share's sides itself, from the generator's ids, with flagd's evaluation library ([which side an id is on](#which-side-an-id-is-on)).

### The evaluation context

Each request is evaluated with four names, and nothing else: what flagd's sync stream sends beside the flags is kept out of the context.

| Name | Value |
|---|---|
| `marked` | `true` when the request carries `x-unmeasured`, whatever its value ([the mark](ADMISSION-CONTROL.md#the-mark)); `false` otherwise |
| `preview` | The flags its [preview cookie](#the-preview-cookie) names, but never the [revision](#the-revision); when this request's ask counts, those flagd still knows with the ones it asks for, as the cookie it sets names them. A list of names, `[]` for none |
| `targetingKey` | Its share id, only when its [signature](#the-shares-signed-ids) checks out; absent otherwise |
| `signed` | `true` exactly when it has a `targetingKey` |

A flag's name is lower-case letters and digits, in words joined by hyphens, as the [preview cookie](#its-contract) names them. A flag named otherwise is always off, and is never evaluated.

### Failing off

A flag is on only when flagd says so. It is off on an error, for a flag flagd does not know, for a value that is not a boolean, and before the app has its first flag set. The provider keeps serving its last flag set while flagd is away, so a kill switch would not reach it: every flag is off once the provider has been without flagd for a minute (it has reported its flag set stale or in error, and not been back in step since), or has heard nothing from flagd for a stream's length and a minute more. Each stream to flagd lasts a minute and the provider then opens another, so a healthy sync is heard from at least every minute, and a connection that died silently is caught within two. A stream that flagd ends cleanly, rather than one that fails or reaches its length, is one the provider neither tells of nor follows with another, so the app watches for it: unless the provider is already reconnecting after reporting its flag set stale or in error, when the sync has been silent for a stream's length and 5 seconds more, the app opens it again on the same provider, which keeps its flag set meanwhile, and tries again after as long again until flagd answers. The silence is counted from when the app starts, so a first stream flagd ends before any flag set is opened again too. Every flag stays off until the provider is in step again.

### The revision

The flag set's revision is a flag of its own, `flag-set-revision`: a string flag with one static variant, whose value names the flag set. Whoever writes `flags` sets it with every change: the admin service, whose every write admission refuses without one ([the stages](#the-stages)), and an administrator by hand. It is not a feature: it is never on, never previewable, and evaluating it as one gives off. Its value is never `none`, `stale` or `invalid`, the words the header below keeps for no revision: a revision spelt as one is told as `invalid`.

The app tells it only to a marked request, on every response, whatever the path, in `x-flags-revision`, set after the route's own headers so that no route can change it:

| Value | When |
|---|---|
| the revision | The flag's value, when it is visible ASCII (`!` to `~`) of 1 to 128 characters, and not one of the three words below |
| `none` | There is no such flag, the app has no sync address, or it has not yet had a flag set |
| `stale` | Every flag is off, as above, because the flag set is stale |
| `invalid` | Any other value, one of these three words among them, or the flag cannot be read as a string |

An unmarked request never gets the header.

### Caching

An answer a flag may have changed is the requester's alone. When a route asked about any flag, or its answer sets the [preview cookie](#the-preview-cookie), the route's own answer is `Cache-Control: private, no-store`, since it depends on the cookie, the share id or the mark, and no cache in between may keep it. Like the revision, the flag context sets its headers after the route's, so no route can undo them.

### On the request's span

Each evaluation of a feature is an event, `feature_flag.evaluation`, on the request's span, named as OpenTelemetry's semantic conventions for feature flags name it. Only a request the app records has a span ([whose requests are judged](PROGRESSIVE-DELIVERY.md#whose-requests-are-judged)), so a marked request's evaluations are not recorded, and the traffic generator's are. Nor is one when the app has no sync address, one of a flag it never evaluates (a name as above, or the revision), or one that throws.

| Attribute | Value |
|---|---|
| `feature_flag.key` | The flag |
| `feature_flag.provider.name` | `flagd` |
| `feature_flag.result.variant` | The variant flagd chose, when it chose one |
| `feature_flag.result.value` | Whether the flag is on for the request: `false` whenever it fails off |
| `feature_flag.result.reason` | flagd's reason, in lower case (`targeting_match`, `static`, `error`); `stale` when the flag set is stale or the app has none yet, and the provider is not asked (where the revision header says `none` before the first flag set) |
| `error.type` | The error, in lower case (`flag_not_found`, `type_mismatch`), only on one |

The event never carries the context: `feature_flag.context.id` would be the share id, and nothing of the app's logs, traces or metrics holds the id or its signature.

### Its settings

On the app's Rollout, in its repository:

- **`FLAGS_SYNC`**, flagd's sync address, `host:port` in plaintext inside the cluster: `flagd.flagd:8015`. Without it, or with one that is not `host:port`, every flag is off. The provider's own `FLAGD_*` variables are overridden, so none set on the pod changes where the flags come from.
- **`SHARE_PUBLIC_KEY_FILE`**, the share's public key: `/etc/share-key/public-key`, from the ConfigMap `share-key`, mounted whole, read-only and optional, so a pod starts without it and a key written after it starts reaches it. The app reads the file for a request that carries all three share headers, at most once a minute. With no file, or one that is not an Ed25519 public key, nothing is signed.

## The preview cookie

A flag at Preview is on for browsers that ask to preview it, with `?preview=<flag>` on any page of the app, and the app remembers the ask in its preview cookie. The app keeps nothing else on a visitor's device, and has no cookie banner: the cookie is set only for someone who asks for the preview, to give them what they asked for, so it is strictly necessary (PECR regulation 6, as the Data (Use and Access) Act 2025 amends it, and the ICO's guidance on storage and access). It is the one thing flags keep on a device. No id for a share of visitors is kept, and none is worked out from an address or a user agent.

The [probes' `/device` check](PROBES-AND-CRAWLER.md#the-probes) allows it only for a browser that asked (`apps/factory/src/senses/device.ts`), and the console's [privacy page](CONSOLE.md#what-it-draws) names it, as the app's own `/privacy` does.

### Its contract

The app sets the cookie exactly as this says, and the `/device` check holds every attribute to it, not the name alone, as the browser kept them: a cookie set with no `SameSite` reads as `Lax`, as Chromium treats it, and one set with `Expires` as one set with the same `Max-Age`, so the lifetime is checked, from the answer to the latest ask, rather than which of the two set it. The check bounds what is kept: a cookie that lasts less than a day, or names fewer flags than were asked for, keeps less, and passes it. That the app sets exactly a day, and that a name is one flagd knows, are the app's own tests' to check:

| | |
|---|---|
| When | Only on a `GET` (or `HEAD`) of one of the app's routes, not a file, `/health` or `/version`, whose `?preview=` names only features flagd knows, not the [revision](#the-revision), in a flag set that is not stale ([failing off](#failing-off)). One that names any other changes nothing, and the app never echoes the parameter. An answer that sets it is `Cache-Control: private, no-store` ([caching](#caching)). |
| Name | `preview` |
| Value | The flags asked for, each once, in the order asked, joined by `.`: `dark-mode.big-buttons`. One ask may name several, each in a `preview` parameter of its own (`?preview=dark-mode&preview=big-buttons`), and counts only when flagd knows every one. Each ask adds its flag to those the cookie already names that flagd still knows. A flag's name is lower-case letters and digits, in words joined by hyphens; a flag named otherwise cannot be previewed. |
| `Path` | `/` |
| `Domain` | None, so it is the app's host's alone |
| `Max-Age` | `86400`: a day from the latest ask. No ask, no renewal. |
| `HttpOnly` | Always: only the app's server reads it |
| `SameSite` | `Lax`, so following a link to the app, as from the console, carries it |
| `Secure` | Exactly when the request reached the app over HTTPS: its own scheme, or `X-Forwarded-Proto: https` from Traefik. The app is served over plain HTTP on every profile today (`website.localhost:8080` through Traefik, `http://website.website` for the probes), so it sets none. A browser drops a `Secure` cookie set over plain HTTP but on a `localhost` name, so one set always would reach a browser through Traefik and never the probes' Chromium, which could not then see it. |

The cookie names flags and decides nothing: flagd does, so a flag turned off is off for a browser whose cookie names it. Nothing removes it but its `Max-Age` or the browser's own settings.

### How a probe asks

A check asks for a preview with its context's `preview(flag)`, which opens `?preview=<flag>` on a path of the app, on its page (`senses/browser.ts`). It is the one way to ask, so the pass knows, and it counts once the app has answered. A pass's checks share a browser context, so from the ask on, every check's `/device` check in that pass allows a `preview` cookie that keeps to the contract and names only flags the pass asked for, in the order asked, and lists it as `allowed`. Anything beside it still fails the check. Without an ask, the cookie fails it like any other; with one, a cookie that breaks the contract fails it with what is wrong (`readable by a script`, `naming big-buttons, which was not asked for`). Verify asks, at a flag's Preview: a check of its own asks for the flag's preview on the front page before the probes run, and the stage passes only with the cookie allowed and nothing else kept that the run with the flag off did not keep ([the probes' checks](RELEASE-AND-VERIFY.md#the-probes-checks)).

## The share's signed ids

A flag's share stage is on for a share of the [traffic generator](TRAFFIC-GENERATOR.md#its-ids)'s requests, chosen by flagd's `fractional` rule over the id each one carries. The id is signed, so that nobody else can walk into the share by sending one.

- **The key.** `make share-key` (and so `make up`) makes an Ed25519 key pair once. The private key is the Secret `share-signing-key` in `factory`, which only the generator mounts. The public key is the ConfigMap `share-key` in `website`, under `public-key`, as SPKI in PEM, written again from the Secret each time the target runs. Only `make share-key`'s user may make, change or delete `share-key` ([admission control](ADMISSION-CONTROL.md#share-key)), so nothing from the app's repository can replace it.
- **The app holds only the public key,** and treats an id as signed only when its signature checks out for that request, is less than a minute old, and is not from the future. It ignores an id without one. With no public key, or one it cannot read, nothing is signed.
- **A signature is a bearer credential,** for its page and its minute, so what keeps visitors out is that none ever sees one. The generator's requests go from its pod to Traefik's Service inside the cluster ([network policies](NETWORK-POLICIES.md#factory)), and Traefik keeps no access log; a test fails if its access log is turned on without dropping the three headers below, or if its tracing captures any of them. The generator puts neither the signature nor its headers in a log, a span or a metric. The ids alone are harmless, since an unsigned id is ignored, so they are a label of the generator's metrics. Anything that read a signature could replay it, for that page and that minute, and the worst it does is show a feature at the share stage and add a request to the figures.
- **Which side an id is on is Verify's to work out,** with flagd's own `fractional` rule, from the flag's stage and share in the admin service's events. The generator never reads `flags` or asks flagd. How, below.

### Which side an id is on

The app evaluates in-process: its provider streams the flag set from flagd's sync port and evaluates each request with flagd's evaluation library, `@openfeature/flagd-core`, at the version its lockfile pins (5.0.0, through `@openfeature/flagd-provider` 0.18.0). That library is the one truth of which side an id is on.

- **Verify evaluates with the same library, at the same version,** pinned exactly in `apps/factory/package.json` ([Verify by variant](RELEASE-AND-VERIFY.md#share)). It renders the flag at its share with `policy/flags.ts`, as the admin service writes it, and evaluates each of the generator's ids in the context the app builds for a signed request: the id as `targetingKey`, `signed`, not `marked`, and no `preview`. Which ids are on depends on the flag's name as well as its share. It evaluates interpreted (`disableDynamicCodeGeneration`), so the line runs no code the library generates.
- **flagd's own evaluation is another implementation, so nothing asks it.** flagd's evaluation service (gRPC, and OFREP) buckets a `fractional` rule with its own Go evaluator, not the app's library, and a flagd release may change how it buckets, as 0.18.0 did, to flagd-core 5.0.0's CBOR rule. Recorded from the image the cluster runs, v0.18.2, the two agree on every one of the 101 ids at every share; nothing holds them to agree on the next. Nothing may ask flagd's RPC or OFREP for a share-stage flag's side.
- **What holds it.** `scripts/flagd-sides.ts` runs the pinned flagd image in Docker for two flags at each share, fetches the flag set over its sync service (the payload the app's provider receives), and records each id's side by flagd-core in the app's compiled mode, and by flagd's own evaluation for contrast, in `apps/factory/test/line/flagd-sides.json`. `compare.test.ts` holds Verify's sides to it, and the record's image and library version to what `deploy/` pins and the factory installs.
- **When the app's flagd-core changes** (its provider bumped, in its repository), pin the factory's to the same version in the same release, run `node scripts/flagd-sides.ts` again, and commit the record: until both move together, Verify's sides may not be the app's. The same when the flagd image, `policy/flags.ts` or the generator's ids change.

### The contract

The app's flag context checks what the generator sends exactly as this says.

Each signed request carries three headers:

| Header | Value |
|---|---|
| `x-share-id` | The id, ASCII: the generator's are `traffic-000` to `traffic-100` |
| `x-share-time` | When it was signed, in whole seconds since the Unix epoch, in decimal with no sign, point or leading zero |
| `x-share-signature` | The Ed25519 signature (RFC 8032, pure Ed25519 with no prehash) of the message below, in base64url with no padding: 86 characters |

The message is six fields, in this order, each its UTF-8 bytes after its length in bytes as an unsigned 32-bit big-endian integer, and nothing between or after them:

1. the context string, `software-factory share-id v1`;
2. the id, as in `x-share-id`;
3. the time, as in `x-share-time`, as its decimal digits;
4. the host: the request's `Host` header, in lower case, with its port when it names one (`website.localhost` on the local profile);
5. the method, in upper case: `GET`, the only one the generator sends;
6. the path: the request target as sent on the request line, the path and its query, percent-encoding and all (`/search?q=glove`), and no fragment.

The app accepts a signature when every one of the three headers is there, once, and `Host` once; the id, `Host`, method and request target are visible ASCII; the time is 1 to 15 digits (a leading zero, which the generator never sends, is not refused, as the signature covers the header as sent); the signature is the one base64url spelling of its 64 bytes; with `now` its own clock in whole seconds, `0 <= now - time < 60`; and the signature verifies, with the public key in `share-key`, over the message it builds from those headers and its own view of the request: its `Host`, method and request target, not anything the request says about itself elsewhere. Anything else and the request is not signed, and the id is not its targeting key.

### Test vector

The private key is RFC 8032's first test key, so its public key is the RFC's too. `apps/factory/test/share.test.ts` holds the generator's code to this block, and the app's tests check their verification against it.

```json
{
  "privateKey": "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n-----END PRIVATE KEY-----\n",
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n",
  "request": { "id": "traffic-007", "time": 1793001600, "host": "website.localhost", "method": "GET", "path": "/search?q=glove" },
  "message": "0000001c736f6674776172652d666163746f72792073686172652d69642076310000000b747261666669632d3030370000000a3137393330303136303000000011776562736974652e6c6f63616c686f7374000000034745540000000f2f7365617263683f713d676c6f7665",
  "headers": {
    "x-share-id": "traffic-007",
    "x-share-time": "1793001600",
    "x-share-signature": "so1eBQuRv1KfCSVYqZIIvAw24N-DIIFbE1IZxbAQiilqhAAZbk5RqiUTthh7gDkK39T_VHLj6I9Q95SArrAeAw"
  }
}
```

The message is in hex. The time is 2026-10-26T08:00:00Z: an app checking this vector against its own clock refuses it, as it should, so its test sets the clock to within the minute after.
