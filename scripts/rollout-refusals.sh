#!/usr/bin/env bash
# Asks the cluster, as the admin service's service account, to patch the app's Rollout as its controls do and as they
# never may, and keeps the answers in deploy/test/rollout-refusals.json: what its Role
# (deploy/base/analysis/admin-controls-release.yaml) and the `website-rollout-controls` admission policy
# (deploy/base/admission/website/rollout-controls.yaml) let through. Run it with both on the cluster, as `main` has
# them, whenever either changes, with credentials that may impersonate a service account (Martin's own), and a few
# seconds after a change: the API server takes a moment to load a policy.
#
# Each patch is a merge patch straight to the API, conditional on the Rollout's resourceVersion as the service's are,
# sent through `kubectl proxy` as its account (`kubectl patch` reads a subresource before it patches it, which the Role
# does not grant and the service does not need), and a server-side dry run: it passes through authorisation and
# admission exactly as a real one does, and nothing is changed. A refusal is the Role's or the policy's; any other
# answer that is not a success (no connection, no Rollout, a conflict, a patch the schema refuses) stops the script,
# so the record holds only the answers of the two gates it is about. Promote moves the status's step on by one, or to
# past the last step when it is there already, so a canary in flight or not, each asks the same of the policy.
#
#   pause             spec.paused set                                                  admitted
#   resume            spec.paused cleared                                              admitted
#   abort             status.abort set                                                 admitted
#   retry             status.abort cleared                                             admitted
#   promote           the status's step moved on, and its pauses cleared               admitted
#   promote-fully     status.promoteFull set                                           admitted
#   image             another image                                                    refused
#   steps             the canary's steps, straight to all of the traffic               refused
#   replicas          another number of replicas                                       refused
#   label             a label added                                                    refused
#   step-back         the status's step sent back by one                               refused
#   step-dropped      the status's step dropped, which sends it back to the start      refused
#   stable            the status's stable version changed                              refused
#   weights           the traffic split's weights in the status                        refused
#   pause-condition   a pause added                                                    refused
#   delete            the Rollout deleted                                              refused (by the Role)
#   traffic           the TraefikService's weights, directly                           refused (by the Role)
#
# The record keeps the hash of the Roles and the policy it was taken against (scripts/policy-hash.ts), which stops the script first
# unless the cluster runs them as deploy/ renders them here, and which apps/factory/test/refusal-records.test.ts holds
# to deploy/, so a change to them fails `make check` until this is run again.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
as=system:serviceaccount:factory:admin
out="$(dirname "$0")/../deploy/test/rollout-refusals.json"
rollout=/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website
# The policies as the cluster runs them, or nothing asked (scripts/policy-hash.ts).
taken=$(node "$(dirname "$0")/policy-hash.ts" rollout-refusals)

at=$(kubectl --context "$context" -n website get rollout website -o jsonpath='{.status.currentStepIndex}')
at=${at:-0}
steps=$(kubectl --context "$context" -n website get rollout website -o json | jq '.spec.strategy.canary.steps | length')
step=$(( at < steps ? at + 1 : steps ))
version=$(kubectl --context "$context" -n website get rollout website -o jsonpath='{.metadata.resourceVersion}')

# The API as the admin service's account, on a port of the proxy's choosing, stopped when this ends.
work=$(mktemp -d)
kubectl --context "$context" --as "$as" proxy --port=0 >"$work/proxy" 2>&1 &
proxy=$!
trap '{ kill "$proxy" && wait "$proxy"; } 2>/dev/null || true; rm -rf "$work"' EXIT
for _ in $(seq 300); do grep -q 'Starting to serve' "$work/proxy" && break; sleep 0.1; done
port=$(sed -n 's/^Starting to serve on 127\.0\.0\.1:\([0-9]*\)$/\1/p' "$work/proxy" | head -n 1)
[[ -n $port ]] || { cat "$work/proxy" >&2; exit 1; }

record() { # case outcome answer: one JSON line
  jq -cn --arg kind "$1" --arg outcome "$2" --arg answer "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{case: $kind, at: $at, outcome: $outcome, message: $answer}'
}

send() { # case method path [patch]: admitted on a 2xx, refused with the API's reason otherwise
  local kind=$1 method=$2 path=$3 code
  code=$(curl -s -o "$work/answer" -w '%{http_code}' -X "$method" -H 'content-type: application/merge-patch+json' \
    "http://127.0.0.1:$port$path?dryRun=All" ${4:+--data "$4"})
  # RBAC answers 403; the policy 403 on the status and 422 on the Rollout itself. Each is told by its message.
  local message
  message=$(jq -r '.message // empty' "$work/answer" 2>/dev/null || true)
  if [[ $code == 2* ]]; then
    record "$kind" admitted "HTTP $code"
  elif [[ $code =~ ^(403|422)$ && ($message == *"ValidatingAdmissionPolicy 'website-rollout-controls'"* ||
    $message == *"User \"$as\" cannot"*) ]]; then
    record "$kind" refused "$message"
  else
    echo "$kind: HTTP $code, neither admitted nor refused by the Role or the policy:" >&2
    cat "$work/answer" >&2
    exit 1
  fi
}

try() { # case subresource patch: the patch made conditional on the Rollout as it was read
  send "$1" PATCH "$rollout${2:+/$2}" "$(jq -cn --argjson patch "$3" --arg version "$version" \
    '$patch * {metadata: {resourceVersion: $version}}')"
}

{
  try pause '' '{"spec":{"paused":true}}'
  try resume '' '{"spec":{"paused":false}}'
  try abort status '{"status":{"abort":true}}'
  try retry status '{"status":{"abort":false}}'
  try promote status "{\"status\":{\"pauseConditions\":null,\"controllerPause\":false,\"currentStepIndex\":$step}}"
  try promote-fully status '{"status":{"promoteFull":true}}'
  try image '' '{"spec":{"template":{"spec":{"containers":[{"name":"website","image":"nginx"}]}}}}'
  try steps '' '{"spec":{"strategy":{"canary":{"steps":[{"setWeight":100}]}}}}'
  try replicas '' '{"spec":{"replicas":5}}'
  try label '' '{"metadata":{"labels":{"rollout-refusal":"x"}}}'
  try step-back status "{\"status\":{\"currentStepIndex\":$(( at - 1 ))}}"
  try step-dropped status '{"status":{"currentStepIndex":null}}'
  try stable status '{"status":{"stableRS":"rollout-refusal"}}'
  try weights status '{"status":{"canary":{"weights":{"canary":{"weight":100,"podTemplateHash":"x","serviceName":"website-canary"},"stable":{"weight":0,"podTemplateHash":"x","serviceName":"website"}}}}}'
  try pause-condition status '{"status":{"pauseConditions":[{"reason":"PausedByUser","startTime":"2026-01-01T00:00:00Z"}]}}'
  send delete DELETE "$rollout"
  send traffic PATCH /apis/traefik.io/v1alpha1/namespaces/website/traefikservices/website \
    '{"spec":{"weighted":{"services":[]}}}'
} >"$work/answers"
jq -s --argjson taken "$taken" '$taken + {cases: .}' "$work/answers" >"$out"
# As `make check` would have it.
pnpm exec biome format --write "$out" >/dev/null
jq -r '.cases[] | "\(.outcome)  \(.case): \(.message)"' "$out"
