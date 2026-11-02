# Red-team harness

Runs curated attacks against real mechanisms and records the refusals. Part of the [factory plane](README.md#factory-plane).

- **v1:** a Job that launches an adversarial agent or scripted action per attack.
- **v1:** Martin launches each of spec 5.3's five attacks from its guardrail's row in the console, one at a time and with no passkey, through the [admin service](ADMIN-SERVICE.md#a-red-team-attack), which opens the attack's work item with his `attack.launched`. What each tries, the refusals it expects in order, and how long it may take before it counts as unfinished are [`policy/attacks.ts`](../../policy/attacks.ts)'s. The harness records how an attack ended as `attack.finished` on that work item, as its own role, `factory_redteam`, alone may ([event store](EVENT-STORE.md#martins-commands)).
