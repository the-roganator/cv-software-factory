# Changelog

## [0.10.0](https://github.com/the-roganator/cv-software-factory/compare/v0.9.0...v0.10.0) (2026-11-01)


### Features

* **admin:** ask every pod of the app which flags it holds, and alert Martin when it lags ([#644](https://github.com/the-roganator/cv-software-factory/issues/644)) ([4bc9908](https://github.com/the-roganator/cv-software-factory/commit/4bc990859562e4b5b27877dc496c99ea99ad7cde))
* **admin:** ask for an improvement in Martin's words, as his command, with the passkey again ([#676](https://github.com/the-roganator/cv-software-factory/issues/676)) ([d640e54](https://github.com/the-roganator/cv-software-factory/commit/d640e543073ee8bc736eeba5e8716d642dfa2f07))
* **admin:** stage a feature flag through the admin service, by rules the console can share ([#642](https://github.com/the-roganator/cv-software-factory/issues/642)) ([5b24e5d](https://github.com/the-roganator/cv-software-factory/commit/5b24e5dbea7c8c7a0336ceb624750b665e944c88))
* **admission:** hold each refusal record to the hash of the policies it was taken against ([#770](https://github.com/the-roganator/cv-software-factory/issues/770)) ([07535c4](https://github.com/the-roganator/cv-software-factory/commit/07535c4669e94b72c5f77d2927883e4714e7d63d))
* **alerts:** one switch in Controls sends every alert to Martin's phone, or none ([#734](https://github.com/the-roganator/cv-software-factory/issues/734)) ([bce2f8c](https://github.com/the-roganator/cv-software-factory/commit/bce2f8c74766e6560278ec38943cc0d37708d8da))
* **alerts:** page Martin when the admin service changes something no event records ([#736](https://github.com/the-roganator/cv-software-factory/issues/736)) ([d9b0798](https://github.com/the-roganator/cv-software-factory/commit/d9b079805f20943277c789f6520bad8df209ea4b))
* **alerts:** page Martin when the factory is unhealthy, a release goes wrong or spend runs out ([#733](https://github.com/the-roganator/cv-software-factory/issues/733)) ([6cde0cb](https://github.com/the-roganator/cv-software-factory/commit/6cde0cb60479231698976d8cf130b786535d603b))
* **ci:** add a review gate and merge queue triggers ahead of the move to an organisation ([#622](https://github.com/the-roganator/cv-software-factory/issues/622)) ([d29d11f](https://github.com/the-roganator/cv-software-factory/commit/d29d11f7824b2ed483b0a025b238af6793694b97))
* **console:** answer a hold and move a flag from the work item's sheet ([#695](https://github.com/the-roganator/cv-software-factory/issues/695)) ([610c704](https://github.com/the-roganator/cv-software-factory/commit/610c704a5a12e136eaa8e3d5ce704f133828ab70))
* **console:** ask for an improvement with the "+", and approve its spec with the passkey ([#680](https://github.com/the-roganator/cv-software-factory/issues/680)) ([7cfa18e](https://github.com/the-roganator/cv-software-factory/commit/7cfa18ea68c7c60855af48f70876ebd6668ded6a))
* **console:** draw a return's next round at once, and move a step in hand ([#697](https://github.com/the-roganator/cv-software-factory/issues/697)) ([e80f433](https://github.com/the-roganator/cv-software-factory/commit/e80f433471857a5e09afdc5d32564d230fa3e4a0))
* **console:** set each flag's stage from Controls, and show visitors the same ([#646](https://github.com/the-roganator/cv-software-factory/issues/646)) ([7d3dfaf](https://github.com/the-roganator/cv-software-factory/commit/7d3dfafb0e6dda3ce2bf6532c68b68609b30d422))
* **console:** show a canary's live figures as each look lands ([#710](https://github.com/the-roganator/cv-software-factory/issues/710)) ([06987ef](https://github.com/the-roganator/cv-software-factory/commit/06987ef765276ffa698be094707202020c275299))
* **console:** switch auto-rollback with the passkey, and show a canary paused for Martin ([#743](https://github.com/the-roganator/cv-software-factory/issues/743)) ([26f92b9](https://github.com/the-roganator/cv-software-factory/commit/26f92b9e2fa374da72582339a2af6dd7a7867826))
* **console:** the canary leaves its cage while a release is in flight ([#712](https://github.com/the-roganator/cv-software-factory/issues/712)) ([9369fbb](https://github.com/the-roganator/cv-software-factory/commit/9369fbb4d08c80faec1218942e76b6a150efaefd))
* **deploy:** keep the mark, holding every route in website to the Middleware that strips it ([#612](https://github.com/the-roganator/cv-software-factory/issues/612)) ([8f86644](https://github.com/the-roganator/cv-software-factory/commit/8f866445f7882c76327f61f097dccc4961f4f881))
* **deploy:** run flagd in its own namespace, reading the one FeatureFlag, flags ([#601](https://github.com/the-roganator/cv-software-factory/issues/601)) ([20327f8](https://github.com/the-roganator/cv-software-factory/commit/20327f8bff9fa701800cc20f1221baa6a71f8cc5))
* **design:** give Triage, Plan and Review new tools, and Verify a pen that signs ([#726](https://github.com/the-roganator/cv-software-factory/issues/726)) ([f29b6aa](https://github.com/the-roganator/cv-software-factory/commit/f29b6aa92fa91bf60d7c53252bd41e75e4820d2b))
* **design:** keep Review's page and Verify's card put away until work starts ([#731](https://github.com/the-roganator/cv-software-factory/issues/731)) ([3946afd](https://github.com/the-roganator/cv-software-factory/commit/3946afdf5ae824c8dd8942c5e4515e0fb92ad1e5))
* **events:** record each look of a canary's background analysis ([#709](https://github.com/the-roganator/cv-software-factory/issues/709)) ([bfa0c67](https://github.com/the-roganator/cv-software-factory/commit/bfa0c67a9f46b1613b3b436ab5c59fd7001ac0da))
* **events:** record refusals at version 3, held to each mechanism's roles ([#756](https://github.com/the-roganator/cv-software-factory/issues/756)) ([adc9c5c](https://github.com/the-roganator/cv-software-factory/commit/adc9c5c3c9c11f18bbcab41aca19a9ea0ff619ea))
* **flagd:** let the admin service stage flags, held to the stages' shapes ([#638](https://github.com/the-roganator/cv-software-factory/issues/638)) ([9269598](https://github.com/the-roganator/cv-software-factory/commit/9269598436007f24f041736a7da45690a9e23656))
* **flags:** hold a widening past Checks or Preview for Verify's check there, and draw its evidence ([#660](https://github.com/the-roganator/cv-software-factory/issues/660)) ([5277092](https://github.com/the-roganator/cv-software-factory/commit/527709283ed2010a2b9a2fa745d89d2c36c359bc))
* **gateway:** record the gateway's and triage's refusals as action.refused ([#757](https://github.com/the-roganator/cv-software-factory/issues/757)) ([164a47b](https://github.com/the-roganator/cv-software-factory/commit/164a47b7f4dac3094b9f50c5b514016f44f2b3ab))
* **github:** act only on the App's own issues and pull requests, and reply once to an outside issue ([#725](https://github.com/the-roganator/cv-software-factory/issues/725)) ([9a2335c](https://github.com/the-roganator/cv-software-factory/commit/9a2335caa42b2cd645ca1c5943788d08ca4563d5))
* **guardrails:** take every guardrail's proof from a clean main, and record each ([#772](https://github.com/the-roganator/cv-software-factory/issues/772)) ([8b0739e](https://github.com/the-roganator/cv-software-factory/commit/8b0739e1a5e4b9bcc9f2f3b4f7148a040c25ef16))
* **implement:** take work items in the app's repository ([#593](https://github.com/the-roganator/cv-software-factory/issues/593)) ([95c5ed4](https://github.com/the-roganator/cv-software-factory/commit/95c5ed4f5a202342b5e027766ecb4d5ba2ec318b))
* **line:** carry an improvement Martin asked for, and hand it to its flag ([#677](https://github.com/the-roganator/cv-software-factory/issues/677)) ([fcab540](https://github.com/the-roganator/cv-software-factory/commit/fcab540149a134235e4eaefa867264cc7df3d330))
* **line:** check a flag with the probes at Off, Checks and Preview, and record flag.checked ([#659](https://github.com/the-roganator/cv-software-factory/issues/659)) ([698de47](https://github.com/the-roganator/cv-software-factory/commit/698de47948f83384a03f5f4e712a53ce4d671b17))
* **line:** close an improvement as turned off when Martin turns its flag off ([#657](https://github.com/the-roganator/cv-software-factory/issues/657)) ([8b0b25a](https://github.com/the-roganator/cv-software-factory/commit/8b0b25aafc5193f99c5715e5f7251e5cdffdb716))
* **line:** close an improvement as verified once its flag is on for everyone ([#690](https://github.com/the-roganator/cv-software-factory/issues/690)) ([7de4bbf](https://github.com/the-roganator/cv-software-factory/commit/7de4bbf24d6b6379f0c30219755bf31077bc3940))
* **line:** close an open ticket a release already fixed, crediting the fix ([#793](https://github.com/the-roganator/cv-software-factory/issues/793)) ([f9afc87](https://github.com/the-roganator/cv-software-factory/commit/f9afc87be77ea722c13a94f2de7a585d7b072475))
* **line:** compare a flag's two sides at Share, and record flag.compared ([#658](https://github.com/the-roganator/cv-software-factory/issues/658)) ([1466025](https://github.com/the-roganator/cv-software-factory/commit/14660254bb3f0f3904ed6a0ccde51a52ae321523))
* **line:** hold scope at once on files the coder needs outside its scope ([#692](https://github.com/the-roganator/cv-software-factory/issues/692)) ([1139c6e](https://github.com/the-roganator/cv-software-factory/commit/1139c6e35048b28c6f88dc8746a6ed7e1f7e6c3a))
* **line:** picture a flag's pages in light and dark at the baseline and Checks ([#704](https://github.com/the-roganator/cv-software-factory/issues/704)) ([585f710](https://github.com/the-roganator/cv-software-factory/commit/585f710d387f8bb07efeeecfdced2fcccc3fd6bb))
* **line:** plan, build, review and describe an improvement behind its flag ([#679](https://github.com/the-roganator/cv-software-factory/issues/679)) ([535448a](https://github.com/the-roganator/cv-software-factory/commit/535448a11fa3a450bd74a1e3365e4a78d7558516))
* **line:** record the GitHub worker's signed refusals and admission's denials ([#759](https://github.com/the-roganator/cv-software-factory/issues/759)) ([2c22623](https://github.com/the-roganator/cv-software-factory/commit/2c22623fee2318dd2086dbec238b573fde30005e))
* **logs:** signal wrong metrics on every route once, on `*` ([#795](https://github.com/the-roganator/cv-software-factory/issues/795)) ([5a98eb9](https://github.com/the-roganator/cv-software-factory/commit/5a98eb9d590009394936e630fca7a5dbc48d4f1a))
* **probes:** allow the app's preview cookie, only for a browser that asked ([#618](https://github.com/the-roganator/cv-software-factory/issues/618)) ([6ec7d62](https://github.com/the-roganator/cv-software-factory/commit/6ec7d627fcb1e791c34b11fd42d671bc83fdd416))
* **release:** hold a canary judged bad for Martin, and take his abort of it for a rollback ([#741](https://github.com/the-roganator/cv-software-factory/issues/741)) ([2587be7](https://github.com/the-roganator/cv-software-factory/commit/2587be7781df4083ae91aabcc2fc750d582fefa8))
* **release:** let Martin switch auto-rollback off, as two series the analysis reads ([#740](https://github.com/the-roganator/cv-software-factory/issues/740)) ([3cbc4fe](https://github.com/the-roganator/cv-software-factory/commit/3cbc4fe987466d201f63dc1940dfa921c82718b2))
* **store:** record a guardrail's proof as the proofs' role alone, and page when one did not hold ([#769](https://github.com/the-roganator/cv-software-factory/issues/769)) ([096ce9f](https://github.com/the-roganator/cv-software-factory/commit/096ce9fe1572d562202fda14d0db0a2d7cacb487))
* **traffic:** sign an id on each of the generator's requests, for a flag's share ([#615](https://github.com/the-roganator/cv-software-factory/issues/615)) ([b842fae](https://github.com/the-roganator/cv-software-factory/commit/b842fae2d2f99751af73b85bf1d9304132c9adba))


### Bug Fixes

* **admission:** admit only the-roganator's images, signed by its build.yml ([#630](https://github.com/the-roganator/cv-software-factory/issues/630)) ([2afe736](https://github.com/the-roganator/cv-software-factory/commit/2afe736edf11a52fd768b61bbe7c423fec813e26))
* **admission:** give each attestor one identity, as Kyverno verifies no other ([#627](https://github.com/the-roganator/cv-software-factory/issues/627)) ([a7f1088](https://github.com/the-roganator/cv-software-factory/commit/a7f1088bd39e0420feab1ae6d0f7a37fafb936db))
* **console:** give ZAP a port of its own, and stop the scan when ZAP stops ([#673](https://github.com/the-roganator/cv-software-factory/issues/673)) ([dd4146c](https://github.com/the-roganator/cv-software-factory/commit/dd4146c48321732ae5345baf94c248378dfa1d0f))
* **console:** listen where the browser tests ask, and say when it cannot ([#670](https://github.com/the-roganator/cv-software-factory/issues/670)) ([d1736a3](https://github.com/the-roganator/cv-software-factory/commit/d1736a318d189ec9cc5ce7b7fb9ad1bdac40c6ab))
* **console:** say each hold on a station's row in a few words, its card's ([#776](https://github.com/the-roganator/cv-software-factory/issues/776)) ([8ff9b6d](https://github.com/the-roganator/cv-software-factory/commit/8ff9b6d64ded144478efe287e6d2872975e40c45))
* **crawler:** judge an asset's caching on the answer a visitor gets ([#802](https://github.com/the-roganator/cv-software-factory/issues/802)) ([40a909d](https://github.com/the-roganator/cv-software-factory/commit/40a909d90a4621c7d58c6f258c451748548b552f))
* cut recorded text between characters, never inside an emoji ([#728](https://github.com/the-roganator/cv-software-factory/issues/728)) ([bfe881e](https://github.com/the-roganator/cv-software-factory/commit/bfe881e2b9955b0e6dac4933896892ff6222c25a))
* **deps:** lift minimatch to 11 for GHSA-g3hv-75wg-m249 ([#785](https://github.com/the-roganator/cv-software-factory/issues/785)) ([e85484d](https://github.com/the-roganator/cv-software-factory/commit/e85484dc31fa1276ec783b94cd58bec8e6c1957e))
* **deps:** lock the fixed releases of five vulnerable indirect dependencies ([#598](https://github.com/the-roganator/cv-software-factory/issues/598)) ([effa621](https://github.com/the-roganator/cv-software-factory/commit/effa62195b73776c30ffe8faea11951726152008))
* **events:** find a file two scope patterns share, by running their automata together ([#647](https://github.com/the-roganator/cv-software-factory/issues/647)) ([66d95ff](https://github.com/the-roganator/cv-software-factory/commit/66d95ff8e52343b39ad9ca584cdfa8bbcf38b26a))
* **events:** match a scope entry on its automaton, not a backtracking regular expression ([#651](https://github.com/the-roganator/cv-software-factory/issues/651)) ([87ecf62](https://github.com/the-roganator/cv-software-factory/commit/87ecf624b11b885226d418132fb6e2b64019b879))
* **factory:** cut the rest of the factory's recorded text between characters ([#738](https://github.com/the-roganator/cv-software-factory/issues/738)) ([c3cfceb](https://github.com/the-roganator/cv-software-factory/commit/c3cfcebda37076eb1b289cd43a7e355ec7051025))
* **flagd:** document the app's flag context, and close flagd's health port to the app ([#634](https://github.com/the-roganator/cv-software-factory/issues/634)) ([cf13577](https://github.com/the-roganator/cv-software-factory/commit/cf13577c5c384db6acbd3d4a20fb8f1cd64f5f5b))
* **gateway:** refuse an agent's call as soon as the line's stop is heard ([#779](https://github.com/the-roganator/cv-software-factory/issues/779)) ([77b99d0](https://github.com/the-roganator/cv-software-factory/commit/77b99d069b79c90a01e4d0213e33517490b26996))
* **gateway:** take judgements with triage's token alone ([#789](https://github.com/the-roganator/cv-software-factory/issues/789)) ([9400399](https://github.com/the-roganator/cv-software-factory/commit/940039987a5d84f869c10619a82d71a9280ffaa5))
* **github:** close a scope fence bypass, and protect what CODEOWNERS gives a person ([#643](https://github.com/the-roganator/cv-software-factory/issues/643)) ([97427f4](https://github.com/the-roganator/cv-software-factory/commit/97427f424e51e879bd48cd4e1c4315e236bf45c2))
* **github:** hold a runner's patch to what patches.ts promises, under property-based tests ([#641](https://github.com/the-roganator/cv-software-factory/issues/641)) ([d96d43e](https://github.com/the-roganator/cv-software-factory/commit/d96d43eeafb986d21a9447aa34c7d9ae2358b8e0))
* **github:** stop the poller's wait leaving a listener on its signal ([#764](https://github.com/the-roganator/cv-software-factory/issues/764)) ([f17b6d5](https://github.com/the-roganator/cv-software-factory/commit/f17b6d57d73736f771b28aa6812599b99f9756a4))
* **guardrails:** prove the gateway's refusal of a stopped line from CI, not the drill ([#774](https://github.com/the-roganator/cv-software-factory/issues/774)) ([863cc44](https://github.com/the-roganator/cv-software-factory/commit/863cc448847279a9314168096b52583f1d35c34d))
* **guardrails:** warn, not fail, when the drift check cannot see who may bypass a ruleset ([#724](https://github.com/the-roganator/cv-software-factory/issues/724)) ([b27372f](https://github.com/the-roganator/cv-software-factory/commit/b27372fca7eae5c8ce5339fe13eb7170d2d51b68))
* **line:** answer and resolve a held review's open threads when Martin approves it ([#702](https://github.com/the-roganator/cv-software-factory/issues/702)) ([d7ca59b](https://github.com/the-roganator/cv-software-factory/commit/d7ca59b810bd42a87d47c9660a03e6079333bc7b))
* **line:** bound a path to what an event records: refuse a patch's, cut a pushed branch's ([#668](https://github.com/the-roganator/cv-software-factory/issues/668)) ([40483b7](https://github.com/the-roganator/cv-software-factory/commit/40483b75792473505e3dd8859093139b84a58e1e))
* **line:** count toward the take only the work items the line worked on ([#800](https://github.com/the-roganator/cv-software-factory/issues/800)) ([dfd13f1](https://github.com/the-roganator/cv-software-factory/commit/dfd13f19074edf13247eaea0fb375906157def12))
* **line:** plan a replan from the pull request's base, told its last spec and why it came back ([#698](https://github.com/the-roganator/cv-software-factory/issues/698)) ([577a1c5](https://github.com/the-roganator/cv-software-factory/commit/577a1c5be564be61e9e681b2aa7bb62bd0a52faa))
* **line:** stop Verify's wait for the probes leaving a listener on the line's signal ([#767](https://github.com/the-roganator/cv-software-factory/issues/767)) ([2d3de66](https://github.com/the-roganator/cv-software-factory/commit/2d3de66370e1419660ff13328c14b6e967fb66d7))
* **logs:** judge no route on metrics that had a gap ([#791](https://github.com/the-roganator/cv-software-factory/issues/791)) ([540b71d](https://github.com/the-roganator/cv-software-factory/commit/540b71d83cd4d78a258031ef577369f56c6e5690))
* **make:** check made-once passwords before storing them, and apply Secrets server-side ([#794](https://github.com/the-roganator/cv-software-factory/issues/794)) ([eae7397](https://github.com/the-roganator/cv-software-factory/commit/eae739702de6e93d238a24f019fa35ea3d1a81c7))
* **make:** make a namespace only when it is missing, never apply one over Argo CD's ([#732](https://github.com/the-roganator/cv-software-factory/issues/732)) ([c5fc8de](https://github.com/the-roganator/cv-software-factory/commit/c5fc8de43d269b991243abf3e7eb1bdd4151c793))
* **probes:** take a screenshot again when Chromium could not capture the frame ([#761](https://github.com/the-roganator/cv-software-factory/issues/761)) ([206539c](https://github.com/the-roganator/cv-software-factory/commit/206539c8f439889021393654dd38416311e191a5))
* **review:** judge a queued stack on every pull request down to main ([#667](https://github.com/the-roganator/cv-software-factory/issues/667)) ([352ecca](https://github.com/the-roganator/cv-software-factory/commit/352eccabebd7b9011d4c0c880747aa5cd2bbc494))
* **review:** judge a stacked pull request, and say why the gate declines one ([#663](https://github.com/the-roganator/cv-software-factory/issues/663)) ([1e12fa6](https://github.com/the-roganator/cv-software-factory/commit/1e12fa6accee9f81e0842712e1b1f3f6b02a032a))
* **runner:** run this repository's pnpm, from mise.lock, in the runner image ([#684](https://github.com/the-roganator/cv-software-factory/issues/684)) ([8dac989](https://github.com/the-roganator/cv-software-factory/commit/8dac989e34789a6fe4a8c8b5b213a33d8592f355))
* **store:** take an artifact's size from the file it is read from ([#595](https://github.com/the-roganator/cv-software-factory/issues/595)) ([7ca9f53](https://github.com/the-roganator/cv-software-factory/commit/7ca9f534fe1a5596dd52df34181c32f59cd97c65))
* **store:** the proofs' role reads no refusals, as no proof reads one ([#777](https://github.com/the-roganator/cv-software-factory/issues/777)) ([a86936f](https://github.com/the-roganator/cv-software-factory/commit/a86936f6237431d6c0b30f58bc0019d0dda73abd))
* **triage:** count an open ticket's problem seen again toward a burst, and hold it there ([#792](https://github.com/the-roganator/cv-software-factory/issues/792)) ([aa4513c](https://github.com/the-roganator/cv-software-factory/commit/aa4513c51355355d7bef1c0128a8c8689ef6a123))
* **triage:** find a visitor's email address however it is wrapped ([#645](https://github.com/the-roganator/cv-software-factory/issues/645)) ([dc4b44a](https://github.com/the-roganator/cv-software-factory/commit/dc4b44a4ba359235bbc1ad2e60004f181d1b107b))
* **visual-pr:** key its description and pictures by repository as well as branch ([#788](https://github.com/the-roganator/cv-software-factory/issues/788)) ([009c870](https://github.com/the-roganator/cv-software-factory/commit/009c87019a9bf462ec9779c547b108577cff763a))
* **visual-pr:** pass a description with an attached video in check.ts ([#727](https://github.com/the-roganator/cv-software-factory/issues/727)) ([9c33bc2](https://github.com/the-roganator/cv-software-factory/commit/9c33bc20b2bd1121a5c2597b771e6b9931198a6c))

## [0.9.0](https://github.com/the-roganator/cv-software-factory/compare/v0.8.0...v0.9.0) (2026-10-24)


### Features

* **admin:** a session lasts 30 minutes from sign-in ([#555](https://github.com/the-roganator/cv-software-factory/issues/555)) ([655034c](https://github.com/the-roganator/cv-software-factory/commit/655034cbe92b8ee6e5270fee22287715b0f6d48b))
* **admin:** answer a hold from Needs you, through the admin service ([#544](https://github.com/the-roganator/cv-software-factory/issues/544)) ([1d784c9](https://github.com/the-roganator/cv-software-factory/commit/1d784c9a3d257f50c113ae4c5a6767354b2010e2))
* **admin:** control the app's canary from the admin service, held by admission to its fields ([#531](https://github.com/the-roganator/cv-software-factory/issues/531)) ([56d8f7e](https://github.com/the-roganator/cv-software-factory/commit/56d8f7e03b46d6570c2781085da126ce9e828f7d))
* **admin:** serve Martin's sign-in, sessions and writes from factory admin ([#512](https://github.com/the-roganator/cv-software-factory/issues/512)) ([268401c](https://github.com/the-roganator/cv-software-factory/commit/268401c476631389429dc9ed5ffdc458efde85b7))
* **admin:** stop and start the line through the admin service, aborting the canary in flight ([#551](https://github.com/the-roganator/cv-software-factory/issues/551)) ([2e9fbd5](https://github.com/the-roganator/cv-software-factory/commit/2e9fbd522a14070eb6e71a71a2f7e78547364550))
* **admin:** the line's controls through the admin service: autonomy, new work, auto-merge, the take ([#552](https://github.com/the-roganator/cv-software-factory/issues/552)) ([95f9db4](https://github.com/the-roganator/cv-software-factory/commit/95f9db4f75bf14683b016829cd50c07701a8622d))
* **alerts:** alert each hold that waits for Martin once, with its links ([#576](https://github.com/the-roganator/cv-software-factory/issues/576)) ([b3dc81b](https://github.com/the-roganator/cv-software-factory/commit/b3dc81b18a6cbbdde58cc432184270e85bd2c449))
* **alerts:** each security event at its own level, and a silent one for Martin's own use ([#563](https://github.com/the-roganator/cv-software-factory/issues/563)) ([b4b069f](https://github.com/the-roganator/cv-software-factory/commit/b4b069f3944b5aa19a795bee4f5177095b66f761))
* **alerts:** inform Martin when the line is stopped, and not when the passkey is given again ([#575](https://github.com/the-roganator/cv-software-factory/issues/575)) ([f5f684c](https://github.com/the-roganator/cv-software-factory/commit/f5f684cb7d1926f6ee92e8df3cb358d6f920504a))
* **alerts:** notify Martin when the shop's pod is 25 days old ([#569](https://github.com/the-roganator/cv-software-factory/issues/569)) ([edd38d8](https://github.com/the-roganator/cv-software-factory/commit/edd38d88b64e0f7c3bb3c659cf5406da20fb2a7a))
* **console:** a lighter header, a footer of icons, and Martin's tools in his menu ([#579](https://github.com/the-roganator/cv-software-factory/issues/579)) ([2ac5e1f](https://github.com/the-roganator/cv-software-factory/commit/2ac5e1f309ad8d147a5a5958e528b55ce11adfc0))
* **console:** a privacy page, and gates that keep visitors' devices empty ([#560](https://github.com/the-roganator/cv-software-factory/issues/560)) ([cb406ea](https://github.com/the-roganator/cv-software-factory/commit/cb406ea777674b4e5263459953b4baac68f9ef77))
* **console:** Martin's controls on the Canary panel, with the passkey asked again ([#532](https://github.com/the-roganator/cv-software-factory/issues/532)) ([0749b0d](https://github.com/the-roganator/cv-software-factory/commit/0749b0df2be06ff61d352129091d6d49e5e70196))
* **console:** Martin's view, a visitor's report text, and Preview as visitor ([#530](https://github.com/the-roganator/cv-software-factory/issues/530)) ([de19d92](https://github.com/the-roganator/cv-software-factory/commit/de19d92f28235de3adc99d040c908aaec5d57230))
* **console:** Needs you, answered from the console, and Waiting on Martin for visitors ([#547](https://github.com/the-roganator/cv-software-factory/issues/547)) ([9c45175](https://github.com/the-roganator/cv-software-factory/commit/9c45175f204c093a1b998e61a2fdb52dcc9571dd))
* **console:** show the tools behind the evidence, as restrained marks ([#583](https://github.com/the-roganator/cv-software-factory/issues/583)) ([fafe589](https://github.com/the-roganator/cv-software-factory/commit/fafe589fb79319ac4c06ac983023d8187c2e8956))
* **console:** sign in and enrol a passkey from the console, scanned by ZAP signed in ([#519](https://github.com/the-roganator/cv-software-factory/issues/519)) ([e1bbb3e](https://github.com/the-roganator/cv-software-factory/commit/e1bbb3e481306ec6ab4fed6dcd1c1c9a6ce31386))
* **console:** Stop and Start the line in the header, and the line's controls in Controls ([#557](https://github.com/the-roganator/cv-software-factory/issues/557)) ([8c4eae0](https://github.com/the-roganator/cv-software-factory/commit/8c4eae0707a8f0dcf5ff29db9c94d1a690e151ef))
* **console:** the audit log, the same for everyone from the public events ([#553](https://github.com/the-roganator/cv-software-factory/issues/553)) ([ec03aa1](https://github.com/the-roganator/cv-software-factory/commit/ec03aa1fe868a2dcc3a6dc381b22ec9f329c4aef))
* **console:** the settings page, and the spend against today's caps in Controls ([#534](https://github.com/the-roganator/cv-software-factory/issues/534)) ([13334b3](https://github.com/the-roganator/cv-software-factory/commit/13334b31b2c003cb1b0f7918d00536a4bdacfe8a))
* **deploy:** connect each worker to the store as its own role ([#502](https://github.com/the-roganator/cv-software-factory/issues/502)) ([8b359fa](https://github.com/the-roganator/cv-software-factory/commit/8b359facb46220a3b919e3f40a1d9d30d6c26d14))
* **deploy:** page Martin through Pushover by an alert's level, and fence Alertmanager ([#545](https://github.com/the-roganator/cv-software-factory/issues/545)) ([b2cd74d](https://github.com/the-roganator/cv-software-factory/commit/b2cd74d988d214d2077925ad4c3de51d9fc998b3))
* **deploy:** run the admin service, under /admin/ on the console's host ([#517](https://github.com/the-roganator/cv-software-factory/issues/517)) ([739769d](https://github.com/the-roganator/cv-software-factory/commit/739769da24d9c47b1103441f3ba33b654a8d88e2))
* **deploy:** serve the local console over HTTPS from a name-constrained local CA ([#501](https://github.com/the-roganator/cv-software-factory/issues/501)) ([5f46751](https://github.com/the-roganator/cv-software-factory/commit/5f4675111915a98ee0f1eb1e6db0a74eec041bf3))
* **gateway:** offer Claude Haiku 5.5 in place of Haiku 4.5 ([#578](https://github.com/the-roganator/cv-software-factory/issues/578)) ([416813d](https://github.com/the-roganator/cv-software-factory/commit/416813d71847f0b0f1a1929b0b0ebf8e40223ce4))
* **github:** open one deploy pull request for the console and the factory together ([#515](https://github.com/the-roganator/cv-software-factory/issues/515)) ([455cb7a](https://github.com/the-roganator/cv-software-factory/commit/455cb7af41155a78700780514cd6a1eed24a73b9))
* **line:** count Martin's security events from the store, and page him on each ([#546](https://github.com/the-roganator/cv-software-factory/issues/546)) ([fcd4aad](https://github.com/the-roganator/cv-software-factory/commit/fcd4aada82eece2129ad0f571231c06bdf681895))
* **line:** record the deploy pull request a held fix waits for, and link it ([#574](https://github.com/the-roganator/cv-software-factory/issues/574)) ([8eafa24](https://github.com/the-roganator/cv-software-factory/commit/8eafa242391ef8b1e2b5fd970739ec9897ed9dbd))
* **settings:** hold Martin's models, efforts and spend caps within policy, read at each step ([#533](https://github.com/the-roganator/cv-software-factory/issues/533)) ([5152428](https://github.com/the-roganator/cv-software-factory/commit/51524282ec014b1cff686feca487046872bbb9ce))
* **store:** give each worker that uses the store a role of its own ([#498](https://github.com/the-roganator/cv-software-factory/issues/498)) ([5690b40](https://github.com/the-roganator/cv-software-factory/commit/5690b40563887e974ab934a095f7b39a7c831562))
* **store:** guard Martin's commands, and the access table they answer to ([#510](https://github.com/the-roganator/cv-software-factory/issues/510)) ([a1bf133](https://github.com/the-roganator/cv-software-factory/commit/a1bf13353dc501731aa26015d3024cb13306e109))
* **telemetry:** keep no visitor's address or user agent, and count browsers ([#559](https://github.com/the-roganator/cv-software-factory/issues/559)) ([150694f](https://github.com/the-roganator/cv-software-factory/commit/150694f7a2306958fc7267fbc913e9156b78b920))
* **triage:** forget a visitor's report 30 days after it was received ([#567](https://github.com/the-roganator/cv-software-factory/issues/567)) ([c189106](https://github.com/the-roganator/cv-software-factory/commit/c1891064134d619239c64c142e7f7112982c9698))


### Bug Fixes

* **admin:** count the next few from now whenever Martin chooses a number ([#581](https://github.com/the-roganator/cv-software-factory/issues/581)) ([cee40a4](https://github.com/the-roganator/cv-software-factory/commit/cee40a443b7155dcd70939f8c1f58c240bce3ad7))
* **admin:** record every sign-out and step-up, and spend no try at two passkeys ([#520](https://github.com/the-roganator/cv-software-factory/issues/520)) ([be6b776](https://github.com/the-roganator/cv-software-factory/commit/be6b776556fe9dbdc5d8d8c8cfd830c917bf9e59))
* **console:** a browser that leaves before an artifact is sent no longer stops the server ([#540](https://github.com/the-roganator/cv-software-factory/issues/540)) ([01bb9cd](https://github.com/the-roganator/cv-software-factory/commit/01bb9cdc0297da075d1e2d80f8acbd1468461f4e))
* **console:** steady Controls, and the line's controls in the settings ([#564](https://github.com/the-roganator/cv-software-factory/issues/564)) ([576c82b](https://github.com/the-roganator/cv-software-factory/commit/576c82b51fe1b19701fa783da2773850a5e54693))
* **egress:** prove the admin service's own fence ([#522](https://github.com/the-roganator/cv-software-factory/issues/522)) ([482a3a3](https://github.com/the-roganator/cv-software-factory/commit/482a3a31da0e1ebe9764c0707e7352a1e8f37716))
* **line:** count the next few from when Martin chose them, to the microsecond ([#572](https://github.com/the-roganator/cv-software-factory/issues/572)) ([619ecf4](https://github.com/the-roganator/cv-software-factory/commit/619ecf41bda18bda7197954d4b4e29085cd7c5d9))

## [0.8.0](https://github.com/the-roganator/cv-software-factory/compare/v0.7.0...v0.8.0) (2026-10-20)


### Features

* **console:** list a stage's work first, with a status icon on each row ([#404](https://github.com/the-roganator/cv-software-factory/issues/404)) ([acdb321](https://github.com/the-roganator/cv-software-factory/commit/acdb321977de5910f43a9e69d1d3f5e9128a4fbe))
* **console:** open the reel on now and leave it still ([#422](https://github.com/the-roganator/cv-software-factory/issues/422)) ([cb422d1](https://github.com/the-roganator/cv-software-factory/commit/cb422d1be98bf0511ee6407dbca74c828a9f5864))
* **deploy:** keep every pod's log in Loki ([#433](https://github.com/the-roganator/cv-software-factory/issues/433)) ([344e9e8](https://github.com/the-roganator/cv-software-factory/commit/344e9e87cdf804f48b7a536a61c8487be5cb50d3))
* **factory:** name the work item and agent in the handback's and the GitHub worker's logs ([#415](https://github.com/the-roganator/cv-software-factory/issues/415)) ([0fc4b0c](https://github.com/the-roganator/cv-software-factory/commit/0fc4b0c970316d3ad3e3eaa958888683edac8f37))
* **gateway:** count tokens by kind, provider errors, cap refusals and spend against the caps ([#484](https://github.com/the-roganator/cv-software-factory/issues/484)) ([6a878cf](https://github.com/the-roganator/cv-software-factory/commit/6a878cf0746780c27d8ce7d2b1ecccf27d74dec0))
* **gateway:** delete cassettes two weeks after the last thing they were for ([#477](https://github.com/the-roganator/cv-software-factory/issues/477)) ([beecc23](https://github.com/the-roganator/cv-software-factory/commit/beecc2381bc09170b4bf71ee48382a649666d061))
* **line:** follow a work item in one trace, from its step to its model calls ([#479](https://github.com/the-roganator/cv-software-factory/issues/479)) ([4f2fec0](https://github.com/the-roganator/cv-software-factory/commit/4f2fec050e7408d09beda8644c2e93458dc38113))
* **line:** look again at held work after a release, and wait on a spec that overlaps ([#430](https://github.com/the-roganator/cv-software-factory/issues/430)) ([45c562d](https://github.com/the-roganator/cv-software-factory/commit/45c562dca1808e0fd50f034377d5be7db32bd8ae))
* **line:** metrics for the line, Release and Verify ([#485](https://github.com/the-roganator/cv-software-factory/issues/485)) ([2ccb4c8](https://github.com/the-roganator/cv-software-factory/commit/2ccb4c80ecd657a51540f86ef564ac9563261099))
* **runners:** keep each runner pod's log with its step, and log what the agent does ([#431](https://github.com/the-roganator/cv-software-factory/issues/431)) ([9e246af](https://github.com/the-roganator/cv-software-factory/commit/9e246af8d26fa1ecee60418e9cbcc5fd82650237))
* **store:** count the store client's queries and connections ([#483](https://github.com/the-roganator/cv-software-factory/issues/483)) ([7beceb3](https://github.com/the-roganator/cv-software-factory/commit/7beceb3b249e8d13e59fd083ff7a46ebd332144e))
* **telemetry:** keep the cluster's state and Postgres's statistics in Prometheus ([#436](https://github.com/the-roganator/cv-software-factory/issues/436)) ([7f0ff6b](https://github.com/the-roganator/cv-software-factory/commit/7f0ff6b23a6e7193706d6a203ffc647d97b57591))
* **telemetry:** record the error budget and stuck limits, and draw the service graph ([#487](https://github.com/the-roganator/cv-software-factory/issues/487)) ([e4df89e](https://github.com/the-roganator/cv-software-factory/commit/e4df89eb3435f4de906a0ed1a426395048e535bd))
* **telemetry:** report each worker's heap, event loop and garbage collection ([#482](https://github.com/the-roganator/cv-software-factory/issues/482)) ([5d410ab](https://github.com/the-roganator/cv-software-factory/commit/5d410ab58c0f999031b1bab8e6b9642b7de565e1))
* **telemetry:** scrape the platform's own metrics ([#434](https://github.com/the-roganator/cv-software-factory/issues/434)) ([1db7a24](https://github.com/the-roganator/cv-software-factory/commit/1db7a24e79a7657a8e7e87a70d06a5fff1162e3f))
* **telemetry:** the app's dashboard led by its objectives, and the platform's ([#489](https://github.com/the-roganator/cv-software-factory/issues/489)) ([158d4bc](https://github.com/the-roganator/cv-software-factory/commit/158d4bc14aed59edd3d1d5eec8d5e6b828e96e31))
* **telemetry:** trace each request out made inside a span ([#478](https://github.com/the-roganator/cv-software-factory/issues/478)) ([362121b](https://github.com/the-roganator/cv-software-factory/commit/362121b2961f87786239685f38a1e2ebfc82838f))
* **triage:** delete the inbox's old repeats ([#476](https://github.com/the-roganator/cv-software-factory/issues/476)) ([7e2f7c9](https://github.com/the-roganator/cv-software-factory/commit/7e2f7c9e41c86e79bdfaec43bfac85f99b15db3c))
* **verify:** name the other work item whose own page a page is ([#471](https://github.com/the-roganator/cv-software-factory/issues/471)) ([f6a44c0](https://github.com/the-roganator/cv-software-factory/commit/f6a44c0eb9f8d0d134ad7aeacdcd5070088165f5))
* **visual-pr:** show a large change two-up, with what moved outlined ([#412](https://github.com/the-roganator/cv-software-factory/issues/412)) ([9fb2fb7](https://github.com/the-roganator/cv-software-factory/commit/9fb2fb73431b6342155fa51acb9d4d3893cee8c9))


### Bug Fixes

* **coder:** run the app's lint, formatting and type check before handing back ([#421](https://github.com/the-roganator/cv-software-factory/issues/421)) ([791c2e6](https://github.com/the-roganator/cv-software-factory/commit/791c2e610a75e6f34a01cf8f5996b2e6cf2cee9a))
* **console:** end a closed work item's story with how it closed ([#411](https://github.com/the-roganator/cv-software-factory/issues/411)) ([1725cd6](https://github.com/the-roganator/cv-software-factory/commit/1725cd61b03555bea24cf89711ce7520fbe76ac5))
* **console:** keep a spec's wait for Martin to a spec that holds for him ([#459](https://github.com/the-roganator/cv-software-factory/issues/459)) ([aa4496c](https://github.com/the-roganator/cv-software-factory/commit/aa4496c35ed2f78162b9c228e9dd29e59b5ecc80))
* **console:** keep the Jev chart's questions and answers on one line, and show its bars' empty part ([#423](https://github.com/the-roganator/cv-software-factory/issues/423)) ([1493684](https://github.com/the-roganator/cv-software-factory/commit/1493684da401db2fafaf3fdeda294e773464c262))
* **console:** name the console's controls with the words they show ([#464](https://github.com/the-roganator/cv-software-factory/issues/464)) ([e6bb4bb](https://github.com/the-roganator/cv-software-factory/commit/e6bb4bb32f83b06c5a18ff8f3a885e706cfb898a))
* **console:** show a promoted release's work at Verify while a sense looks ([#458](https://github.com/the-roganator/cv-software-factory/issues/458)) ([3f5cf90](https://github.com/the-roganator/cv-software-factory/commit/3f5cf900a95e4ff79749908944d51a2302c3b126))
* **deploy:** bound Tempo's searches and have Go collect before its limit ([#400](https://github.com/the-roganator/cv-software-factory/issues/400)) ([c570c75](https://github.com/the-roganator/cv-software-factory/commit/c570c750fe0f068d5391a335609ac6e8553c256e))
* **deploy:** have Grafana find a trace's logs by its trace_id field ([#417](https://github.com/the-roganator/cv-software-factory/issues/417)) ([13a053c](https://github.com/the-roganator/cv-software-factory/commit/13a053ccb7a8cd9a73ada5d6fb234110622a8ff9))
* **deploy:** have Loki's compactor delete logs older than seven days ([#398](https://github.com/the-roganator/cv-software-factory/issues/398)) ([219d13b](https://github.com/the-roganator/cv-software-factory/commit/219d13b0e296a9b4bf7438d11ab81f5ba3515dbc))
* **deploy:** store k3s's metrics once, and keep Prometheus within its volume ([#399](https://github.com/the-roganator/cv-software-factory/issues/399)) ([eac2307](https://github.com/the-roganator/cv-software-factory/commit/eac2307a19520c128621fe6ce36c99f8727277d4))
* **egress:** wait for the pod log collector's DaemonSet by its name, pod-logs-agent ([#480](https://github.com/the-roganator/cv-software-factory/issues/480)) ([3de971a](https://github.com/the-roganator/cv-software-factory/commit/3de971a95c4d42871330f6470d531919e698e050))
* **factory:** log an error with its causes, so fetch failed says why ([#397](https://github.com/the-roganator/cv-software-factory/issues/397)) ([4766735](https://github.com/the-roganator/cv-software-factory/commit/4766735f05167ab2028a8c2341fbb8d5a5b765d1))
* **factory:** move the log watcher's report cursor when a check finds nothing ([#396](https://github.com/the-roganator/cv-software-factory/issues/396)) ([31f5c82](https://github.com/the-roganator/cv-software-factory/commit/31f5c82b3c745eb1eaf7590b2c09328a25e5cd97))
* **factory:** quieten routine polling in the factory's logs and traces ([#416](https://github.com/the-roganator/cv-software-factory/issues/416)) ([4e36d4a](https://github.com/the-roganator/cv-software-factory/commit/4e36d4a6151dcf107b5a1baa70fc8dcce1b8b72e))
* **factory:** read reports back over a margin, so one that reaches Loki late is still sent ([#406](https://github.com/the-roganator/cv-software-factory/issues/406)) ([8e324e8](https://github.com/the-roganator/cv-software-factory/commit/8e324e894ca16ddacfd01ebed8041a4d98758965))
* **line:** answer 404 for the logs of a work item the line kept none for ([#470](https://github.com/the-roganator/cv-software-factory/issues/470)) ([061e9f5](https://github.com/the-roganator/cv-software-factory/commit/061e9f5916cbc87e35596de18943821b20f3691c))
* **line:** end what a dry run left on real tickets once the line runs live ([#420](https://github.com/the-roganator/cv-software-factory/issues/420)) ([20da684](https://github.com/the-roganator/cv-software-factory/commit/20da684c8a221e21a71b24a93669fecb0d91ebef))
* **line:** keep a triage hold answered in words on Needs you ([#425](https://github.com/the-roganator/cv-software-factory/issues/425)) ([ee76d0b](https://github.com/the-roganator/cv-software-factory/commit/ee76d0b065588d3602ab1b7628a1a6cdf7a94afa))
* **line:** name the work item when closing a dry run's leftover issue ([#428](https://github.com/the-roganator/cv-software-factory/issues/428)) ([79a3887](https://github.com/the-roganator/cv-software-factory/commit/79a3887cd2d3301b92964aaf8d85f42c282b3ae9))
* **line:** number a step after its work item's job tokens too ([#456](https://github.com/the-roganator/cv-software-factory/issues/456)) ([fc424ee](https://github.com/the-roganator/cv-software-factory/commit/fc424ee3010fed3b6ecbfc1952ec644fc6bb3a4b))
* **line:** record the gates on a merged pull request's head with its merge ([#457](https://github.com/the-roganator/cv-software-factory/issues/457)) ([9ebc3c8](https://github.com/the-roganator/cv-software-factory/commit/9ebc3c83f22f93043f913063d0cd41ec77bd39e4))
* **line:** run one step at a time on the local model ([#438](https://github.com/the-roganator/cv-software-factory/issues/438)) ([25caa08](https://github.com/the-roganator/cv-software-factory/commit/25caa085210279b0c4c160782a63a3239c455e27))
* **line:** send back work whose gates fail on a newer commit after they passed ([#461](https://github.com/the-roganator/cv-software-factory/issues/461)) ([23f107c](https://github.com/the-roganator/cv-software-factory/commit/23f107c9d25f00d4c9a820cc9618515a7df3a463))
* **line:** take a coder's change with no patch that declines every suggestion as declining them all ([#395](https://github.com/the-roganator/cv-software-factory/issues/395)) ([beca90c](https://github.com/the-roganator/cv-software-factory/commit/beca90cbc3b9af975b4df32e4ab0d2f81bfd9e66))
* **probes:** say why a finding has no screenshot ([#481](https://github.com/the-roganator/cv-software-factory/issues/481)) ([dd4e5fc](https://github.com/the-roganator/cv-software-factory/commit/dd4e5fc54688a78eb45cee77463aef826a158e54))
* **release:** record how many of the journeys' checks passed at each canary step ([#419](https://github.com/the-roganator/cv-software-factory/issues/419)) ([4072464](https://github.com/the-roganator/cv-software-factory/commit/40724641078e3f7c3213fae196c8f566ac954bbb))
* **runner:** name the model that answered each turn, not the SDK's ([#469](https://github.com/the-roganator/cv-software-factory/issues/469)) ([500953e](https://github.com/the-roganator/cv-software-factory/commit/500953e8fba213228af04c07585a7738f5ddf6a4))
* **skills:** have /implement answer Copilot's review summary, not only its threads ([#495](https://github.com/the-roganator/cv-software-factory/issues/495)) ([d5e0009](https://github.com/the-roganator/cv-software-factory/commit/d5e00095ba74399d05a31e5f6a463fd5efc65938))
* **telemetry:** have Prometheus scrape the pod log collector's own metrics ([#473](https://github.com/the-roganator/cv-software-factory/issues/473)) ([cc5ee19](https://github.com/the-roganator/cv-software-factory/commit/cc5ee191c1948be32b092dfed164fe30c7949f5d))
* **telemetry:** scrape what asks only in the platform's namespaces ([#474](https://github.com/the-roganator/cv-software-factory/issues/474)) ([27ffa6a](https://github.com/the-roganator/cv-software-factory/commit/27ffa6a56b43b80001f5827ee3ce9b279ecb13b5))
* **telemetry:** start each count at 0, so the first of each kind after a restart counts ([#492](https://github.com/the-roganator/cv-software-factory/issues/492)) ([9fd34c5](https://github.com/the-roganator/cv-software-factory/commit/9fd34c5344177cb8fc3d48b432a0d9242e04a534))
* **telemetry:** sum each worker's log counts before naming the worker, under Loki's series cap ([#493](https://github.com/the-roganator/cv-software-factory/issues/493)) ([27d5a7d](https://github.com/the-roganator/cv-software-factory/commit/27d5a7d62d6a98e8762a4b5f3d27eae0e755a191))
* **triage:** ask Martin again when it gives up on his answer, so a restart does not retry it ([#414](https://github.com/the-roganator/cv-software-factory/issues/414)) ([f65797f](https://github.com/the-roganator/cv-software-factory/commit/f65797f2c55d1a6098b6de1d784b5b3931738d7a))
* **triage:** count a finding into the held one with its fingerprint, so Martin answers it once ([#410](https://github.com/the-roganator/cv-software-factory/issues/410)) ([4d325eb](https://github.com/the-roganator/cv-software-factory/commit/4d325eb11e05effeb05943256869bbc82de66edc))
* **triage:** count only the scrape targets the senses read ([#475](https://github.com/the-roganator/cv-software-factory/issues/475)) ([f27a496](https://github.com/the-roganator/cv-software-factory/commit/f27a496f494946c099e76c85c3464824bd7eb02e))

## [0.7.0](https://github.com/the-roganator/cv-software-factory/compare/v0.6.0...v0.7.0) (2026-10-17)


### Features

* **console:** list a station's work in hand first, marked as the station marks itself ([#319](https://github.com/the-roganator/cv-software-factory/issues/319)) ([aedb0ac](https://github.com/the-roganator/cv-software-factory/commit/aedb0acf43799d02677ef5104dd152580eb92a02))
* **console:** say both versions' figures beside a failed measure's excess ([#318](https://github.com/the-roganator/cv-software-factory/issues/318)) ([a961667](https://github.com/the-roganator/cv-software-factory/commit/a961667b2c1a83de79c348d815f57b9523e2514b))
* **line:** give the describer the description rules /visual-pr follows ([#349](https://github.com/the-roganator/cv-software-factory/issues/349)) ([eef5abe](https://github.com/the-roganator/cv-software-factory/commit/eef5abe8fbd536cada1339ad5346028940b8d63f))
* **line:** have the coder take or decline the reviewer's suggestions ([#274](https://github.com/the-roganator/cv-software-factory/issues/274)) ([0f6d6d5](https://github.com/the-roganator/cv-software-factory/commit/0f6d6d5ab39f73f0dce807e7e0d068e18a857ab5))
* **line:** have the planner quote the words each criterion comes from ([#339](https://github.com/the-roganator/cv-software-factory/issues/339)) ([fb81865](https://github.com/the-roganator/cv-software-factory/commit/fb81865bb378ea56ce506459770cdd10bae63906))
* **release:** count a rolled-back measure's failed looks, and say it on the Canary panel ([#341](https://github.com/the-roganator/cv-software-factory/issues/341)) ([92d9f0e](https://github.com/the-roganator/cv-software-factory/commit/92d9f0ebd15b7213d2789d36c5a624d276359009))
* **release:** record an aborted release, so a stop is not inferred ([#271](https://github.com/the-roganator/cv-software-factory/issues/271)) ([943aade](https://github.com/the-roganator/cv-software-factory/commit/943aade0eb1260773b106790f4ea72efbc4447f5))
* **release:** record an analysis that could not judge the canary as an end of its own ([#320](https://github.com/the-roganator/cv-software-factory/issues/320)) ([c2ad85b](https://github.com/the-roganator/cv-software-factory/commit/c2ad85bd80d6b2bbc09e3357e7507c5a24bd26ee))
* **skills:** add /implement, which takes issues or a brief to pull requests ([#334](https://github.com/the-roganator/cv-software-factory/issues/334)) ([b568b0d](https://github.com/the-roganator/cv-software-factory/commit/b568b0d4f9ba7b0ccb0b51ea108e8275d88c33d8))
* **skills:** have visual-pr show a change's snapshots before and after ([#301](https://github.com/the-roganator/cv-software-factory/issues/301)) ([c3c7477](https://github.com/the-roganator/cv-software-factory/commit/c3c74779558280d267780474b47d7dce1a523436))
* **skills:** have visual-pr show a changed snapshot as a blink ([#344](https://github.com/the-roganator/cv-software-factory/issues/344)) ([43f9192](https://github.com/the-roganator/cv-software-factory/commit/43f91926919b913af6598e3ac42d1a7cb90c8a05))
* **skills:** have visual-pr write shorter descriptions and fold supporting sections ([#345](https://github.com/the-roganator/cv-software-factory/issues/345)) ([eeaa016](https://github.com/the-roganator/cv-software-factory/commit/eeaa01632c2fb229399ec51a7b2a609cda4322e1))
* **triage:** hold a burst of new problems from one sense for Martin ([#330](https://github.com/the-roganator/cv-software-factory/issues/330)) ([34fe72c](https://github.com/the-roganator/cv-software-factory/commit/34fe72c6672c3a13e7458f44868277a93b7f17aa))
* **triage:** hold a sense's new problem while what it reads is unhealthy ([#342](https://github.com/the-roganator/cv-software-factory/issues/342)) ([ea3d78d](https://github.com/the-roganator/cv-software-factory/commit/ea3d78d498ce456934bd7e238c15953786a1bc99))
* **triage:** record a signal seen again in a new version on its open ticket ([#266](https://github.com/the-roganator/cv-software-factory/issues/266)) ([bf1d3fd](https://github.com/the-roganator/cv-software-factory/commit/bf1d3fd96eb4ad3af270a67dd601f79dbc8ac38b))


### Bug Fixes

* call the app the app in the agents' prompts and triage's questions ([#331](https://github.com/the-roganator/cv-software-factory/issues/331)) ([4b8b7e4](https://github.com/the-roganator/cv-software-factory/commit/4b8b7e4388a401af53cfb8e1d2549dbccbbe035f))
* call the app the app, not the shop, in the factory's code, console and docs ([#321](https://github.com/the-roganator/cv-software-factory/issues/321)) ([7e2d314](https://github.com/the-roganator/cv-software-factory/commit/7e2d31410673f8ecae2dba2ab25044ba9dcc3741))
* **console:** count a sheet's event times in days past a day, in a column sized to hold them ([#304](https://github.com/the-roganator/cv-software-factory/issues/304)) ([1608e85](https://github.com/the-roganator/cv-software-factory/commit/1608e8553e2050478a35ff2932a1df5ed7622c09))
* **console:** count a sheet's reviews in the pass the line limits them by ([#308](https://github.com/the-roganator/cv-software-factory/issues/308)) ([d2aba71](https://github.com/the-roganator/cv-software-factory/commit/d2aba7146bdcb092208046dfd66f628b0849613f))
* **console:** don't render the reel to stop a history that isn't playing ([#254](https://github.com/the-roganator/cv-software-factory/issues/254)) ([202222e](https://github.com/the-roganator/cv-software-factory/commit/202222e6d9967339f1f53886bbf7c17b9b871f8e))
* **console:** draw a rollback's marker label over the plot, clear of the end labels ([#307](https://github.com/the-roganator/cv-software-factory/issues/307)) ([350151e](https://github.com/the-roganator/cv-software-factory/commit/350151e03b9417a1fa773037eab7ddd03747bb9b))
* **console:** draw the Canary panel's measures waiting before the first step is measured ([#340](https://github.com/the-roganator/cv-software-factory/issues/340)) ([cc4aa05](https://github.com/the-roganator/cv-software-factory/commit/cc4aa05d848fe5784ffcd491d05c5932bfdb8c53))
* **console:** show a window of the timeline, and say its versions in words ([#353](https://github.com/the-roganator/cv-software-factory/issues/353)) ([8385752](https://github.com/the-roganator/cv-software-factory/commit/83857521c35ef6ed8c6bd0b12785bc553f74cfb4))
* **console:** write a commit by its first seven characters under the timeline ([#303](https://github.com/the-roganator/cv-software-factory/issues/303)) ([3242b48](https://github.com/the-roganator/cv-software-factory/commit/3242b488e8f37d6bdfd234307312cfb9bed595d6))
* **console:** write a duration as one value, 5d 1h rather than 5 d 1 h ([#300](https://github.com/the-roganator/cv-software-factory/issues/300)) ([f7874e1](https://github.com/the-roganator/cv-software-factory/commit/f7874e1d4102512aed416775e7cfb5b407b67a86))
* **deploy:** give the GitHub worker the memory a merge needs ([#368](https://github.com/the-roganator/cv-software-factory/issues/368)) ([4442b38](https://github.com/the-roganator/cv-software-factory/commit/4442b3865720c2af9b74b6e79b8c11899b45dff5))
* **deploy:** have the factory read telemetry through a read-only proxy ([#351](https://github.com/the-roganator/cv-software-factory/issues/351)) ([d123f8f](https://github.com/the-roganator/cv-software-factory/commit/d123f8fc5464a929ed15b1d0485aaefaece08741))
* **deploy:** have the intake and the log watcher name each telemetry backend's pods ([#350](https://github.com/the-roganator/cv-software-factory/issues/350)) ([a6cd286](https://github.com/the-roganator/cv-software-factory/commit/a6cd28614b1aa25117dd301bfaa231d91e606147))
* **deploy:** let the line read Tempo, for Verify's agreement check ([#333](https://github.com/the-roganator/cv-software-factory/issues/333)) ([ff34c03](https://github.com/the-roganator/cv-software-factory/commit/ff34c032be158b741ed1606090fb95794f4e0fdb))
* **egress:** report a failed exec as that check's FAIL, and wait for rollouts ([#361](https://github.com/the-roganator/cv-software-factory/issues/361)) ([e03cbc1](https://github.com/the-roganator/cv-software-factory/commit/e03cbc15cb9ce014173e1bf0c4a028ad9a6d8ef2))
* **egress:** run each worker's checks from a probe pod made from its Deployment ([#366](https://github.com/the-roganator/cv-software-factory/issues/366)) ([c80f786](https://github.com/the-roganator/cv-software-factory/commit/c80f786d347cebab8655a6b77699c608acd4dbb7))
* **line:** cut a planner finding's page and route at their query instead of refusing the result ([#338](https://github.com/the-roganator/cv-software-factory/issues/338)) ([2f0f0e8](https://github.com/the-roganator/cv-software-factory/commit/2f0f0e80155f1152a01ce7335a69101c999b81c3))
* **line:** resolve the threads of findings a later review finds answered ([#264](https://github.com/the-roganator/cv-software-factory/issues/264)) ([57a098c](https://github.com/the-roganator/cv-software-factory/commit/57a098c5f6e001617be80778565ee324f71cb286))
* **line:** verify a missing-log or wrong-metric ticket by the agreement check ([#329](https://github.com/the-roganator/cv-software-factory/issues/329)) ([fd4ce91](https://github.com/the-roganator/cv-software-factory/commit/fd4ce9119cdd5d95c928788eb6a4a3d76499c999))
* **logs:** count the agreement check's traces with a TraceQL metrics query ([#369](https://github.com/the-roganator/cv-software-factory/issues/369)) ([ac25bfa](https://github.com/the-roganator/cv-software-factory/commit/ac25bfa58f3a14fa5a177aa713b13ac470543978))
* **logs:** learn the day's error patterns a page at a time, with only the fields read ([#367](https://github.com/the-roganator/cv-software-factory/issues/367)) ([5e22f61](https://github.com/the-roganator/cv-software-factory/commit/5e22f617e659e4477f712ffce772d0178f65d16a))
* **logs:** one ticket for a gap in the log, not one per page ([#326](https://github.com/the-roganator/cv-software-factory/issues/326)) ([bf69135](https://github.com/the-roganator/cv-software-factory/commit/bf69135e0168eb7d512426760f813bb78e6667c6))
* **pictures:** box every element the senses boxed on a page ([#262](https://github.com/the-roganator/cv-software-factory/issues/262)) ([f523017](https://github.com/the-roganator/cv-software-factory/commit/f523017a8ec585e08ba44dcbb7c64ef1bd26ad7a))
* **release:** name a release by its hash and the Rollout's revision ([#265](https://github.com/the-roganator/cv-software-factory/issues/265)) ([3005fa1](https://github.com/the-roganator/cv-software-factory/commit/3005fa1f4ee2d99c72fee10fc611f4ba99011fff))
* **release:** record a background rollback at the weight the canary reached ([#310](https://github.com/the-roganator/cv-software-factory/issues/310)) ([ee482a1](https://github.com/the-roganator/cv-software-factory/commit/ee482a1e089fbabebf228689531ecb2ca09d7cab))
* **release:** record a missed release of an image promoted before ([#311](https://github.com/the-roganator/cv-software-factory/issues/311)) ([f5324ae](https://github.com/the-roganator/cv-software-factory/commit/f5324aee34dff46c086bfac5de7651a3a477fcb2))
* **samples:** send an approval's suggestions back to the coder, as the line does ([#309](https://github.com/the-roganator/cv-software-factory/issues/309)) ([ce1ce2d](https://github.com/the-roganator/cv-software-factory/commit/ce1ce2d7bbc20eccd16ac2b786df5de8edfffa51))
* **senses:** leave the senses' requests out of the app's figures ([#263](https://github.com/the-roganator/cv-software-factory/issues/263)) ([9e6fb79](https://github.com/the-roganator/cv-software-factory/commit/9e6fb7933c14885b05c97e5e281dd0ec43267efc))
* **senses:** read as the app's only the telemetry the collector stamped ([#354](https://github.com/the-roganator/cv-software-factory/issues/354)) ([81dd731](https://github.com/the-roganator/cv-software-factory/commit/81dd731084c7938877a1e7547da0367ae3092287))
* **store:** remove the test Postgres's data volume with its container ([#295](https://github.com/the-roganator/cv-software-factory/issues/295)) ([4b41abc](https://github.com/the-roganator/cv-software-factory/commit/4b41abc09b7cba958aad7f88a59eb052b21ebdae))


### Performance Improvements

* **console:** run the console on Preact, at half the JavaScript ([#284](https://github.com/the-roganator/cv-software-factory/issues/284)) ([77a3209](https://github.com/the-roganator/cv-software-factory/commit/77a3209b571a5ab1b95fdf6856c16c931603594f))

## [0.6.0](https://github.com/the-roganator/cv-software-factory/compare/v0.5.0...v0.6.0) (2026-10-13)


### Features

* **admission:** enforce the factory's image policy ([#185](https://github.com/the-roganator/cv-software-factory/issues/185)) ([d9441e8](https://github.com/the-roganator/cv-software-factory/commit/d9441e8d1e88ca8e581bb46551c0246ad765f5e2))
* **admission:** enforce the website's image policy ([#186](https://github.com/the-roganator/cv-software-factory/issues/186)) ([bd11ef3](https://github.com/the-roganator/cv-software-factory/commit/bd11ef3b8b98df8ef7ee83aa62576f172d24dc10))
* **console:** draw a release as it ships, in the Canary panel ([#232](https://github.com/the-roganator/cv-software-factory/issues/232)) ([fb5ee6d](https://github.com/the-roganator/cv-software-factory/commit/fb5ee6d4a66fbd6ee71bbdc1eb2652ee7a0ae42e))
* **console:** mark each release's version on the timeline, one with no work item at its time ([#237](https://github.com/the-roganator/cv-software-factory/issues/237)) ([29f60a0](https://github.com/the-roganator/cv-software-factory/commit/29f60a0cdd54c3c2eb27695f43421ef415cb9e7b))
* **console:** show the scoreboard beside the app's name ([#233](https://github.com/the-roganator/cv-software-factory/issues/233)) ([b588c14](https://github.com/the-roganator/cv-software-factory/commit/b588c14b648ba4c72fed47f490b3628be8e9ac77))
* **console:** tell a work item's releases and verification on its sheet ([#234](https://github.com/the-roganator/cv-software-factory/issues/234)) ([e8ca520](https://github.com/the-roganator/cv-software-factory/commit/e8ca520952136f4edcf4a93e007a0331698c394c))
* **deploy:** admit only images their pipeline signed, with Kyverno ([#174](https://github.com/the-roganator/cv-software-factory/issues/174)) ([97aa373](https://github.com/the-roganator/cv-software-factory/commit/97aa3730ad3110f97653c38fb68b8e4f4b99c1ab))
* **deploy:** install Argo Rollouts, and label the app's telemetry by version ([#170](https://github.com/the-roganator/cv-software-factory/issues/170)) ([fb81c57](https://github.com/the-roganator/cv-software-factory/commit/fb81c57ae0bf11e6910052b1a3950ff329588747))
* **deploy:** run the scoreboard in its own namespace, fenced ([#224](https://github.com/the-roganator/cv-software-factory/issues/224)) ([fd4e486](https://github.com/the-roganator/cv-software-factory/commit/fd4e4863d9638217b42171bd6880792111d27051))
* **deploy:** run the traffic generator in the cluster ([#172](https://github.com/the-roganator/cv-software-factory/issues/172)) ([41bffca](https://github.com/the-roganator/cv-software-factory/commit/41bffcade590e825db188fd9614cc8120fdf8fa5))
* **github:** say what a deploy pull request carries ([#192](https://github.com/the-roganator/cv-software-factory/issues/192)) ([94ac7ea](https://github.com/the-roganator/cv-software-factory/commit/94ac7ea8f525476008e569801f5f9d97610f943a))
* **github:** sign every image, and propose only what the pipeline signed ([#169](https://github.com/the-roganator/cv-software-factory/issues/169)) ([7ba69d6](https://github.com/the-roganator/cv-software-factory/commit/7ba69d6929222714bd83a11738086587c7ed1038))
* **line:** abort a canary when the line stops, and fence the release ([#175](https://github.com/the-roganator/cv-software-factory/issues/175)) ([f150844](https://github.com/the-roganator/cv-software-factory/commit/f150844348c54c1b37a788df9b183f9a83b28068))
* **line:** carry a merged work item to Release and Verify ([#191](https://github.com/the-roganator/cv-software-factory/issues/191)) ([6252b0c](https://github.com/the-roganator/cv-software-factory/commit/6252b0ca35a4121cf7281ed5affed37616dbd976))
* **line:** record the canary's steps when a release starts ([#219](https://github.com/the-roganator/cv-software-factory/issues/219)) ([425c141](https://github.com/the-roganator/cv-software-factory/commit/425c1415180dcda9fa138d0f835c9259b3280aec))
* **line:** turn a failed canary analysis into a signal ([#201](https://github.com/the-roganator/cv-software-factory/issues/201)) ([7b81a2d](https://github.com/the-roganator/cv-software-factory/commit/7b81a2d2faf61a007f9e32c34f59b7e3089bbe79))
* **line:** verify a release by the sense that saw the defect ([#194](https://github.com/the-roganator/cv-software-factory/issues/194)) ([2b6b69f](https://github.com/the-roganator/cv-software-factory/commit/2b6b69f0e1997c4c5c610206047c1cf5476dd806))
* **line:** watch the app's release, read-only ([#193](https://github.com/the-roganator/cv-software-factory/issues/193)) ([07d5ac2](https://github.com/the-roganator/cv-software-factory/commit/07d5ac2c56b2519c34ddb550f23ca8eeddacda27))
* **pictures:** delete pictures no release needs ([#221](https://github.com/the-roganator/cv-software-factory/issues/221)) ([cafd755](https://github.com/the-roganator/cv-software-factory/commit/cafd755451217acefa6d1649e50788c331612062))
* **probes:** compare every page on the stable and the canary ([#196](https://github.com/the-roganator/cv-software-factory/issues/196)) ([f800eb3](https://github.com/the-roganator/cv-software-factory/commit/f800eb329f2b785f5d1319d5d86298814b16d8eb))
* **release:** judge the app's canary against its baseline, with traffic to judge by ([#171](https://github.com/the-roganator/cv-software-factory/issues/171)) ([5a0d6fc](https://github.com/the-roganator/cv-software-factory/commit/5a0d6fcfddb0f2cd9d0b310f736fbc85a5b0c185))
* **samples:** ship the samples' last week as milestone 6's line does ([#231](https://github.com/the-roganator/cv-software-factory/issues/231)) ([63fac48](https://github.com/the-roganator/cv-software-factory/commit/63fac483d38be3664ff7f2da0993c5d45e487533))
* **scoreboard:** count tickets against the answer key ([#220](https://github.com/the-roganator/cv-software-factory/issues/220)) ([ea33ca2](https://github.com/the-roganator/cv-software-factory/commit/ea33ca2f491c59dc4dff46c2ffa124b80419d154))
* **triage:** reopen a verified ticket when its signal returns ([#195](https://github.com/the-roganator/cv-software-factory/issues/195)) ([04374e5](https://github.com/the-roganator/cv-software-factory/commit/04374e52e59142357435378e372f9d16c02f7ce2))


### Bug Fixes

* **admission:** verify the signature only, not the SBOM ([#184](https://github.com/the-roganator/cv-software-factory/issues/184)) ([8adc43d](https://github.com/the-roganator/cv-software-factory/commit/8adc43d77cc7b2bfb22c98722a4058cb5ae7de57))
* **console:** draw a return only until its work moves on, and boxes where they belong ([#225](https://github.com/the-roganator/cv-software-factory/issues/225)) ([ed5c4ce](https://github.com/the-roganator/cv-software-factory/commit/ed5c4cec2727ceacdc2cfeeb09835a83a3a6a712))
* **console:** draw the shipping states as the design has them ([#251](https://github.com/the-roganator/cv-software-factory/issues/251)) ([2c18148](https://github.com/the-roganator/cv-software-factory/commit/2c181484556a601c0f7f8641dd524fb92584d853))
* **deploy:** give the GitHub worker a writable /tmp, which TUF needs ([#187](https://github.com/the-roganator/cv-software-factory/issues/187)) ([2e2877f](https://github.com/the-roganator/cv-software-factory/commit/2e2877fa029a07f9ff45b1ddceb521f58eaca3f7))
* **egress:** ask about pods' subresources as subresources ([#230](https://github.com/the-roganator/cv-software-factory/issues/230)) ([8225dde](https://github.com/the-roganator/cv-software-factory/commit/8225ddeb7efd70fe3f007afd667dda385107fea8))
* **github:** find a signature when GHCR's index carries no annotations ([#181](https://github.com/the-roganator/cv-software-factory/issues/181)) ([1e44502](https://github.com/the-roganator/cv-software-factory/commit/1e44502d1e7ac099a9baa0e41232bc66aa346f1b))
* **pictures:** box only the ticket's own check on its pages ([#218](https://github.com/the-roganator/cv-software-factory/issues/218)) ([a0b9b30](https://github.com/the-roganator/cv-software-factory/commit/a0b9b30cc8378529bbdb710bbafb3b1d29d10143))
* **release:** keep the factory's own requests out of the canary's figures ([#222](https://github.com/the-roganator/cv-software-factory/issues/222)) ([423e33f](https://github.com/the-roganator/cv-software-factory/commit/423e33fafd25239b49b3807617e8724b087aeb59))
* show the fixed picture and the right hold on a verified work item's sheet ([#212](https://github.com/the-roganator/cv-software-factory/issues/212)) ([d7e4cf7](https://github.com/the-roganator/cv-software-factory/commit/d7e4cf735ab0512b4798a93f47029e18e2e328b7))

## [0.5.0](https://github.com/the-roganator/cv-software-factory/compare/v0.4.0...v0.5.0) (2026-10-10)


### Features

* **console:** show a station at work while it holds an item for Martin ([#164](https://github.com/the-roganator/cv-software-factory/issues/164)) ([b570e51](https://github.com/the-roganator/cv-software-factory/commit/b570e51deb2eac286f8e490eb0806899306babd9))
* **console:** the line's work items, from spec to Martin's merge ([#102](https://github.com/the-roganator/cv-software-factory/issues/102)) ([30a0f97](https://github.com/the-roganator/cv-software-factory/commit/30a0f9791efdc7559b44c5bc9dddbb0f3ab2ee7e))
* **deploy:** run the GitHub worker on the local cluster ([#65](https://github.com/the-roganator/cv-software-factory/issues/65)) ([110448f](https://github.com/the-roganator/cv-software-factory/commit/110448f669cbed7a74cc911fc23da9cc169b9d30))
* **deploy:** run the line, and fence its runners ([#72](https://github.com/the-roganator/cv-software-factory/issues/72)) ([9f113de](https://github.com/the-roganator/cv-software-factory/commit/9f113dee9243c251f3f3bb300982fd43570993fb))
* **factory:** a GitHub worker that acts as the factory's App ([#62](https://github.com/the-roganator/cv-software-factory/issues/62)) ([2d32591](https://github.com/the-roganator/cv-software-factory/commit/2d32591d131c0fdf9a8e626e67eb075055bc9bc7))
* **factory:** the App opens the deploy and release pull requests ([#66](https://github.com/the-roganator/cv-software-factory/issues/66)) ([bcb06d9](https://github.com/the-roganator/cv-software-factory/commit/bcb06d98db1b023819af0bdf137900ece502d639))
* **gateway:** speak Anthropic's Messages API for runners ([#70](https://github.com/the-roganator/cv-software-factory/issues/70)) ([1ec4a6e](https://github.com/the-roganator/cv-software-factory/commit/1ec4a6e4525500d3b39f33bb8cb49a31731d87c4))
* **line:** hold every fix to its ticket, and send what else the planner notices to triage ([#158](https://github.com/the-roganator/cv-software-factory/issues/158)) ([aced509](https://github.com/the-roganator/cv-software-factory/commit/aced50930cc3cc9c0c3acfc5f5f217f9b18e3008))
* **line:** let the coder change nothing and say why, and hold for Martin ([#111](https://github.com/the-roganator/cv-software-factory/issues/111)) ([098cd8a](https://github.com/the-roganator/cv-software-factory/commit/098cd8a3aff2a036dfd029a0332289e5b95c1540))
* **line:** take at most LINE_TAKE work items, by the line's own rule ([#106](https://github.com/the-roganator/cv-software-factory/issues/106)) ([8a3591f](https://github.com/the-roganator/cv-software-factory/commit/8a3591f016b4b1e813e8cc28e31dd92a1ef7e01d))
* **line:** the bench, and cassettes that replay a step run again ([#97](https://github.com/the-roganator/cv-software-factory/issues/97)) ([ff851a1](https://github.com/the-roganator/cv-software-factory/commit/ff851a1a18698ac163b1da3966ab5381dcc8432e))
* **line:** the coder ([#99](https://github.com/the-roganator/cv-software-factory/issues/99)) ([d34dd92](https://github.com/the-roganator/cv-software-factory/commit/d34dd9298f4f090a8e0ca7fafbe931cf489bc507))
* **line:** the describer ([#101](https://github.com/the-roganator/cv-software-factory/issues/101)) ([971f1e2](https://github.com/the-roganator/cv-software-factory/commit/971f1e2ec143e51108af8f870de5b29dda121db1))
* **line:** the line after triage, from ticket to Martin's merge ([#96](https://github.com/the-roganator/cv-software-factory/issues/96)) ([cd447bb](https://github.com/the-roganator/cv-software-factory/commit/cd447bb6b8527f8261a7d173228b84341ddb0cd4))
* **line:** the planner ([#98](https://github.com/the-roganator/cv-software-factory/issues/98)) ([7ad8dc4](https://github.com/the-roganator/cv-software-factory/commit/7ad8dc4e641a1eb6adaeba637c3dcb23f20b5e23))
* **line:** the reviewer, and the loop back to the coder ([#100](https://github.com/the-roganator/cv-software-factory/issues/100)) ([5779393](https://github.com/the-roganator/cv-software-factory/commit/5779393cd81647c43408f2dd710c02b0026aacc0))
* **line:** what the overnight soak needs ([#103](https://github.com/the-roganator/cv-software-factory/issues/103)) ([4917fd8](https://github.com/the-roganator/cv-software-factory/commit/4917fd8731488d9ac4d1f02a7d050ce7d59e2b4a))
* require code-owner review on main, with a bypass for the admin ([#68](https://github.com/the-roganator/cv-software-factory/issues/68)) ([288308e](https://github.com/the-roganator/cv-software-factory/commit/288308eca609eeaeffc896fe0893577de0ea9141))
* runners, and the patch they hand back ([#71](https://github.com/the-roganator/cv-software-factory/issues/71)) ([4ad6906](https://github.com/the-roganator/cv-software-factory/commit/4ad690652cbf2b1da95cad3ff81844c26722fb7b))
* the app's gates, as a shared workflow ([#69](https://github.com/the-roganator/cv-software-factory/issues/69)) ([bd57672](https://github.com/the-roganator/cv-software-factory/commit/bd576722eb6d6fec91f82d5e8f8a56b8af4ab67b))


### Bug Fixes

* **console:** write a commit by its first seven characters, linked on the sheet ([#149](https://github.com/the-roganator/cv-software-factory/issues/149)) ([32d1d32](https://github.com/the-roganator/cv-software-factory/commit/32d1d32f9637de8c7bfc6c16383755622945521a))
* **crawler:** judge a page where it landed, and a route with no page as trouble ([#110](https://github.com/the-roganator/cv-software-factory/issues/110)) ([9a2606a](https://github.com/the-roganator/cv-software-factory/commit/9a2606a6a9b60e7bdcab7094560b95899e7b2de1))
* **deploy:** a default memory limit in runners, which the quota needs ([#89](https://github.com/the-roganator/cv-software-factory/issues/89)) ([7f28cf0](https://github.com/the-roganator/cv-software-factory/commit/7f28cf043bbeae09925f9b2788e364b518fd7742))
* **deploy:** the line's readiness on its handback port ([#88](https://github.com/the-roganator/cv-software-factory/issues/88)) ([c74a0e2](https://github.com/the-roganator/cv-software-factory/commit/c74a0e2095e03828409fb41a8541d096ef90d764))
* **gateway:** resume only the day and month caps after a restart ([#146](https://github.com/the-roganator/cv-software-factory/issues/146)) ([9031b85](https://github.com/the-roganator/cv-software-factory/commit/9031b8549ef0390003cce9cdeba896dd9d28bf07))
* **github:** describe a deploy pull request so it can be read ([#136](https://github.com/the-roganator/cv-software-factory/issues/136)) ([0fa9f93](https://github.com/the-roganator/cv-software-factory/commit/0fa9f933b1b5c788bbec8454bed8967ac961e642))
* **github:** keep a deploy branch to one writer, the deploy watch ([#148](https://github.com/the-roganator/cv-software-factory/issues/148)) ([ce3de17](https://github.com/the-roganator/cv-software-factory/commit/ce3de174ec0fddb6fb2c002138b24898805ae274))
* **github:** move a deploy pull request to a newer build without closing it ([#115](https://github.com/the-roganator/cv-software-factory/issues/115)) ([0848e66](https://github.com/the-roganator/cv-software-factory/commit/0848e6628ab4d41e14efed017918fc99a0ef9e08))
* **github:** refuse a patch path with a control character in it ([#127](https://github.com/the-roganator/cv-software-factory/issues/127)) ([7c0597c](https://github.com/the-roganator/cv-software-factory/commit/7c0597c92f900959882ce16393cee0388a095f12))
* **line:** count no call the provider refused in a step's model.called ([#147](https://github.com/the-roganator/cv-software-factory/issues/147)) ([23e16b3](https://github.com/the-roganator/cv-software-factory/commit/23e16b31d28ba63f06b8e218fc038c46d6a198df))
* **line:** review a change whose gates pass after they sent it back ([#114](https://github.com/the-roganator/cv-software-factory/issues/114)) ([e8f72f3](https://github.com/the-roganator/cv-software-factory/commit/e8f72f32e36521dd17b924bc07a091dbcc1fde52))
* **line:** wait at a spend cap instead of failing the step ([#138](https://github.com/the-roganator/cv-software-factory/issues/138)) ([09c99e5](https://github.com/the-roganator/cv-software-factory/commit/09c99e52aeac586ec383983d70b3f6f27a307175))
* **policy:** name no effort for the local model, and send it none ([#155](https://github.com/the-roganator/cv-software-factory/issues/155)) ([a037a0c](https://github.com/the-roganator/cv-software-factory/commit/a037a0ccee04d964c7099a539cca7b1c7db58d61))
* **probes:** file a home page link's redirect loop under the route that loops ([#64](https://github.com/the-roganator/cv-software-factory/issues/64)) ([b708c6d](https://github.com/the-roganator/cv-software-factory/commit/b708c6d07250660df6fd49a6b500ef96d8b4361e))
* **runners:** delete a Job with its pods, and frame every body ([#90](https://github.com/the-roganator/cv-software-factory/issues/90)) ([dbb53ee](https://github.com/the-roganator/cv-software-factory/commit/dbb53ee5861a6e8dd4d2fc55175f684f4fbde1bb))


### Performance Improvements

* **gates:** observe the base and the change at once, and retry only what failed ([#150](https://github.com/the-roganator/cv-software-factory/issues/150)) ([e677059](https://github.com/the-roganator/cv-software-factory/commit/e677059f4c14848b113feb84d5ec7756fe9d7d52))

## [0.4.0](https://github.com/the-roganator/cv-software-factory/compare/v0.3.1...v0.4.0) (2026-10-04)


### Features

* **console:** show the factory's first real work, sensing and triage ([#51](https://github.com/the-roganator/cv-software-factory/issues/51)) ([681386d](https://github.com/the-roganator/cv-software-factory/commit/681386dbd113a133d53ec8cd59f33b3eb65128c7))
* **crawler:** check every page and asset any site should pass ([#47](https://github.com/the-roganator/cv-software-factory/issues/47)) ([2b6f00c](https://github.com/the-roganator/cv-software-factory/commit/2b6f00ca649e19aca4be17b81826c1289fd7f6d5))
* **deploy:** run the factory's workers on the local cluster ([#49](https://github.com/the-roganator/cv-software-factory/issues/49)) ([dd31af7](https://github.com/the-roganator/cv-software-factory/commit/dd31af7fab2c40d15fee476f8c6737cf8b8fd459))
* **events:** settle version 1 of the events and the store before real work ([#41](https://github.com/the-roganator/cv-software-factory/issues/41)) ([6d389c7](https://github.com/the-roganator/cv-software-factory/commit/6d389c7e809a685b79afd7b84e0dc61746a1b5c1))
* **gateway:** make the gateway the only way to a model ([#42](https://github.com/the-roganator/cv-software-factory/issues/42)) ([d6d60c9](https://github.com/the-roganator/cv-software-factory/commit/d6d60c989259f23056f1bb9db0735279d6ea06a4))
* **probes:** look after the app the way a visitor does ([#46](https://github.com/the-roganator/cv-software-factory/issues/46)) ([82f4baa](https://github.com/the-roganator/cv-software-factory/commit/82f4baaf99dbaca892a7af4992b0a94be9d873aa))
* **telemetry:** alert on the app's objectives and watch its logs ([#48](https://github.com/the-roganator/cv-software-factory/issues/48)) ([19d3fbd](https://github.com/the-roganator/cv-software-factory/commit/19d3fbdc6ffd0b1304465e8ec4d8745ac0449028))
* **triage:** turn the inbox into deduplicated tickets ([#44](https://github.com/the-roganator/cv-software-factory/issues/44)) ([952ccf8](https://github.com/the-roganator/cv-software-factory/commit/952ccf88d01c9f4467cbd1ad5bdbc26380211813))

## [0.3.1](https://github.com/the-roganator/cv-software-factory/compare/v0.3.0...v0.3.1) (2026-10-03)


### Bug Fixes

* **console:** decode page thumbnails with the frame that draws them ([#35](https://github.com/the-roganator/cv-software-factory/issues/35)) ([1f14f44](https://github.com/the-roganator/cv-software-factory/commit/1f14f44604bfe052d21207104e4b63377136fac3))
* **samples:** make samples installs what it needs on a fresh clone ([#34](https://github.com/the-roganator/cv-software-factory/issues/34)) ([224338c](https://github.com/the-roganator/cv-software-factory/commit/224338c3a5a1e4d2928dc499ca0d0ea36266268d))

## [0.3.0](https://github.com/the-roganator/cv-software-factory/compare/v0.2.0...v0.3.0) (2026-10-03)


### Features

* **deploy:** run the console against the event store on the local cluster ([#31](https://github.com/the-roganator/cv-software-factory/issues/31)) ([574f10c](https://github.com/the-roganator/cv-software-factory/commit/574f10ce56daf387a2594a47119ab5037dec7fed))
* the event store and the console, fed from samples ([#30](https://github.com/the-roganator/cv-software-factory/issues/30)) ([bc0bf88](https://github.com/the-roganator/cv-software-factory/commit/bc0bf88d1f6f22f838ac1c3a94c072cf00a2376f))

## [0.2.0](https://github.com/the-roganator/cv-software-factory/compare/v0.1.1...v0.2.0) (2026-10-02)


### Features

* **deploy:** run The World's Worst Website on the local cluster ([#24](https://github.com/the-roganator/cv-software-factory/issues/24)) ([21149b8](https://github.com/the-roganator/cv-software-factory/commit/21149b898b5fdc1a3bd5f7834becb5a818d27424))

## [0.1.1](https://github.com/the-roganator/cv-software-factory/compare/v0.1.0...v0.1.1) (2026-09-30)


### Bug Fixes

* **deploy:** make up waits until everything is deployed ([#13](https://github.com/the-roganator/cv-software-factory/issues/13)) ([ad58072](https://github.com/the-roganator/cv-software-factory/commit/ad58072921376573e9bbe946cf260cd685e11a65))

## 0.1.0 (2026-09-30)


### Features

* lay the foundations ([5479643](https://github.com/the-roganator/cv-software-factory/commit/54796434c4b777b54e2127aaffe4388df9ede305))


### Bug Fixes

* **ci:** let the first bot pull requests through their checks ([#4](https://github.com/the-roganator/cv-software-factory/issues/4)) ([5e56636](https://github.com/the-roganator/cv-software-factory/commit/5e5663605bc62bef4a726a7a35e55d500ffafa17))
* **ci:** sign the deploy commit, so main accepts it ([#9](https://github.com/the-roganator/cv-software-factory/issues/9)) ([457e566](https://github.com/the-roganator/cv-software-factory/commit/457e5668414e5a4c882c8c9920c11af269687dc1))
* **ci:** stop dispatching checks that never count ([#11](https://github.com/the-roganator/cv-software-factory/issues/11)) ([806e902](https://github.com/the-roganator/cv-software-factory/commit/806e902a5065b0ad88889982de56e9bc13006ff0))
* **release:** start at 0.1.0, and leave release-please's manifest alone ([#8](https://github.com/the-roganator/cv-software-factory/issues/8)) ([150c87b](https://github.com/the-roganator/cv-software-factory/commit/150c87b048cf2fcf067c955f15ffaa0339fb8957))
