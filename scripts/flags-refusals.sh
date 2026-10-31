#!/usr/bin/env bash
# Asks the cluster to make a second FeatureFlag in `flagd`, to delete `flags` and to change its flags, and keeps the
# answers of the `flagd-flags` admission policy (deploy/base/admission/flagd/flags.yaml) in
# deploy/test/flags-refusals.json, which apps/factory/test/flag-fences.test.ts holds to what each case must get. Run it
# with the policy and `flags` on the cluster, as `main` has them, whenever the policy changes, with credentials that
# may make, change and delete FeatureFlags there (Martin's own), and a few seconds after a change: the API server takes
# a moment to load a policy.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made,
# changed or deleted. A refusal must be the policy's; any other answer that is not a success (no connection, no
# `flags`, a change the schema refuses) stops the script, so the record holds only the policy's own answers.
#
#   second   another FeatureFlag in flagd, which flagd's watch would read too            refused
#   delete   flags deleted, which would leave flagd serving the last flags it read        refused
#   change   a flag added to flags, as the console will                                   admitted
#
# The record keeps the hash of the policy it was taken against (scripts/policy-hash.ts), which stops the script first
# unless the cluster runs it as deploy/ renders it here, and which apps/factory/test/refusal-records.test.ts holds to
# deploy/, so a change to it fails `make check` until this is run again.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context" -n flagd)
# REFUSALS_OUT writes the record elsewhere, as `make guardrails` takes it, and leaves deploy/test/ as it is.
out="${REFUSALS_OUT:-$(dirname "$0")/../deploy/test/flags-refusals.json}"
policy="ValidatingAdmissionPolicy 'flagd-flags'"
# The policies as the cluster runs them, or nothing asked (scripts/policy-hash.ts).
taken=$(node "$(dirname "$0")/policy-hash.ts" flags-refusals)

try() { # case command...: one JSON line, admitted on success, refused only by the policy
  local kind=$1 answer outcome
  shift
  if answer=$("$@" 2>&1); then outcome=admitted
  elif [[ $answer == *"$policy"* ]]; then outcome=refused
  else
    echo "$kind: neither admitted nor refused by the policy:" >&2
    echo "$answer" >&2
    exit 1
  fi
  jq -cn --arg kind "$kind" --arg outcome "$outcome" --arg answer "$answer" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{case: $kind, at: $at, outcome: $outcome, message: ($answer | sub("^Error from server[^:]*: (error when creating \"STDIN\": )?"; ""))}'
}

second() {
  "${kubectl[@]}" create --dry-run=server -o name -f - <<EOF
apiVersion: core.openfeature.dev/v1beta1
kind: FeatureFlag
metadata:
  name: flags-refusal
spec:
  flagSpec:
    flags: {}
EOF
}

# Kept aside until every case has answered, so a script that stops leaves the record as it was.
answers=$(mktemp)
trap 'rm -f "$answers"' EXIT
{
  try second second
  try delete "${kubectl[@]}" delete featureflag flags --dry-run=server
  try change "${kubectl[@]}" patch featureflag flags --type merge --dry-run=server -o name -p \
    '{"spec":{"flagSpec":{"flags":{"flags-refusal":{"state":"ENABLED","variants":{"on":true,"off":false},"defaultVariant":"off"}}}}}'
} >"$answers"
jq -s --argjson taken "$taken" '$taken + {cases: .}' "$answers" >"$out"
# As `make check` would have it.
[ -n "${REFUSALS_OUT:-}" ] || pnpm exec biome format --write "$out" >/dev/null
jq -r '.cases[] | "\(.outcome)  \(.case): \(.message)"' "$out"
