# 0018: A refusal record's hash leaves out the tags and digests admission admits

## Decision

Every refusal record in `deploy/test/` keeps a hash of the image policy it was taken under (ADR 0010), and `refusal-records.test.ts` holds that hash to what `deploy/` renders (`policyHash()`, `scripts/policy-hash.ts`). The hash reads each image reference a copy of the policy admits cut to its repository, and whether it is by digest: `postgres:18.6-alpine3.24@sha256:123b…` is read as `postgres@sha256`. Everything else counts: every rule and variable, the namespaces each copy guards, the repositories it admits from other registries and how many. A list the hash cannot read as plain references is read whole, so a rule written there counts as any other does.

Two tests hold what the hash leaves out:

- `refusal-records.test.ts`: each reference a copy admits is one a workload in a namespace that copy guards pins, image for image and digest for digest, so nothing is admitted that no workload runs.
- `admission.test.ts`: no image a record says was refused is one its copy now admits, so moving a pin cannot quietly admit an image the record shows refused.

Only the hash leaves them out. The checks that the cluster runs what `deploy/` renders, and that `deploy/` renders as the revision Argo CD's root is synced to, compare every field, the admitted digests included.

## Why

- **What a record proves never depended on them.** The record shows Kyverno refusing an unsigned image, one signed by another identity, one of ours in the wrong namespace and flagd at another digest. None of those answers changes when Postgres, its exporter or flagd moves to a new digest: the rules that gave them are the same.
- **A digest bump would need a cluster for nothing.** If the hash read the digests, every such bump would stale the record, and only a cluster synced to the branch with every policy enforcing can take it again. No CI job can, so every bump, and every move the daily scan makes ([ADR 0026](0026-the-daily-scan-decides-every-move.md)), would wait for the owner's machine.
- **The digests are not the policy's to choose.** Kustomize copies them from the workloads' own pins, so a bump is one line and the policy follows. Holding them to the workloads by a test keeps what the hash held: nothing is admitted unless a workload pins it.

## Consequences

- A Postgres, exporter or flagd digest or tag bump stales no refusal record, and needs no cluster to merge.
- A change to any rule of the image policy, to the namespaces a copy guards, or to the repositories or the number of images a copy admits from another registry, stales `admission-refusals.json`, which is taken again with `scripts/admission-refusals.sh`.
- A record does not say which digests were admitted when it was taken; its `revision` does, and the tests say they are the workloads'.
- A flagd release that changes what flagd's Roles must allow still stales `flag-stages-refusals.json`, whose hash covers Roles and policies with no `allowed` variable.
