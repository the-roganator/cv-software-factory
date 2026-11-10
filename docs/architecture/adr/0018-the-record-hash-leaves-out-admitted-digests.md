# 0018: A refusal record's hash leaves out the tags and digests admission admits

## Decision

`policyHash()` (`scripts/policy-hash.ts`), which every refusal record in `deploy/test/` keeps and `refusal-records.test.ts` holds to what `deploy/` renders, reads each copy of the image policy (ADR 0010) with the references its `allowed` variable lists cut to their repositories: `postgres:18.6-alpine3.24@sha256:123b…` is read as `postgres`. Everything else counts as before: every rule and variable, the namespaces each copy guards, the repositories it admits from other registries and how many. An `allowed` that is anything but a list of string literals is read whole, so a rule written there counts as any other does.

Two tests hold what the hash no longer reads:

- `refusal-records.test.ts`: each reference a copy admits is, image for image and digest for digest, one a workload in a namespace that copy guards pins (kustomize copies it from there, `deploy/base/kustomization.yaml`), so nothing is admitted that no workload runs.
- `admission.test.ts`: no image a record says was refused is one its copy now admits, so moving a pin cannot quietly admit an image the record shows refused (`flagd`'s `other-digest` case, flagd at an earlier release, among them).

Only the hash changes. `policy-hash.ts`'s check that the cluster runs what `deploy/` renders still compares every field, the admitted digests included, and so does its check that `deploy/` here renders as the revision Argo CD's root is synced to.

## Why

- **What a record proves never depended on them.** `admission-refusals.json` shows Kyverno refusing an unsigned image, one signed by another identity, one of ours in the wrong namespace and flagd at another digest. None of those answers changes when Postgres, its exporter or flagd moves to a new digest: the rules that gave them are the same.
- **A digest bump needed a cluster for nothing.** Each such bump changed the hash, so `make check` failed until the record was taken again on a cluster synced to the branch, with every image policy enforcing (#951's Postgres bump did exactly that, for answers identical but for the hash and the times). No CI job can take it, so every Postgres, exporter or flagd bump waited for Martin's Mac, and the pin moves of milestone 7's Part D would too.
- **The digests are not the policy's to choose.** They are copies of the workloads' own pins, made by kustomize, so a bump is one line Dependabot writes and the policy follows. Holding them to the workloads by a test keeps what the hash held: nothing is admitted unless a workload pins it.

## Consequences

- A Postgres, exporter or flagd digest or tag bump stales no refusal record, and needs no cluster to merge. Replayed on #951: the old hash moved (`482397f9…` to `137ec757…`), the new one stands (`be88c873…` before and after).
- A change to any rule of the image policy, to the namespaces a copy guards, or to the repositories or the number of images a copy admits from another registry, stales `admission-refusals.json` as before, and it is taken again with `scripts/admission-refusals.sh`.
- A record no longer says which digests were admitted when it was taken; its `revision` does, and the tests say they are the workloads'.
- A flagd release that changes what flagd's Roles must allow still stales `flag-stages-refusals.json`, whose hash covers Roles and policies with no `allowed` variable.
- The proofs recorded in the store before this change keep the hashes they were taken with; a proof taken again after it is judged against a record taken under the new hash.
