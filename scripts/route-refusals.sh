#!/usr/bin/env bash
# Asks the cluster to make, in `website`, Traefik routes the app's repository might send, and keeps the answers of the
# `website-routes` admission policy (deploy/base/admission/website/routes.yaml) in deploy/test/route-refusals.json,
# which apps/factory/test/admin-fences.test.ts holds to what each case must get. Run it with the policy on the cluster,
# as `main` has it, whenever the policy changes.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made.
# Each route asks for the highest priority, on the HTTPS entrypoint, as one that meant to take the console's host would,
# and goes through the Middleware `visitors`, as `website-mark` (mark.yaml) requires. A refusal must be this policy's;
# any other answer that is not a success stops the script, so the record holds only this policy's own answers.
#
#   app               the app's own host, as its route has it                       admitted
#   app-path          the app's host and a path, joined with &&                     admitted
#   console           the console's host                                            refused
#   no-host           a path alone, which would match every host                    refused
#   or-console        the app's host, or the console's                              refused
#   host-regexp       any host, by pattern                                          refused
#   console-and-app   the console's host first, then the app's                      refused
#
# The record keeps the hash of the policy it was taken against (scripts/policy-hash.ts), which stops the script first
# unless the cluster runs it as deploy/ renders it here, and which apps/factory/test/refusal-records.test.ts holds to
# deploy/, so a change to it fails `make check` until this is run again.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
# REFUSALS_OUT writes the record elsewhere, as `make guardrails` takes it, and leaves deploy/test/ as it is.
out="${REFUSALS_OUT:-$(dirname "$0")/../deploy/test/route-refusals.json}"
policy="Policy website-routes failed"
# The policies as the cluster runs them, or nothing asked (scripts/policy-hash.ts).
taken=$(node "$(dirname "$0")/policy-hash.ts" route-refusals)

try() { # case match: one JSON line, what was asked and what the cluster answered
  local kind=$1 match=$2 answer outcome
  if answer=$(kubectl --context "$context" -n website create --dry-run=server -o name -f - 2>&1 <<EOF
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: route-refusal
spec:
  entryPoints: [websecure]
  routes:
    - kind: Rule
      match: "$match"
      priority: 2147483647
      middlewares:
        - name: visitors
      services:
        - name: website
          port: 80
EOF
  ); then outcome=admitted
  elif [[ $answer == *"$policy"* ]]; then outcome=refused
  else
    echo "$kind: neither admitted nor refused by the policy:" >&2
    echo "$answer" >&2
    exit 1
  fi
  jq -cn --arg kind "$kind" --arg match "$match" --arg outcome "$outcome" --arg answer "$answer" \
    --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{case: $kind, match: $match, at: $at, outcome: $outcome,
      message: ($answer | sub("^Error from server: error when creating \"STDIN\": "; ""))}'
}

# Kept aside until every case has answered, so a script that stops leaves the record as it was.
answers=$(mktemp)
trap 'rm -f "$answers"' EXIT
{
  try app 'Host(`website.localhost`)'
  try app-path 'Host(`website.localhost`) && PathPrefix(`/x`)'
  try console 'Host(`console.localhost`)'
  try no-host 'PathPrefix(`/`)'
  try or-console 'Host(`website.localhost`) || Host(`console.localhost`)'
  try host-regexp 'HostRegexp(`.+`)'
  try console-and-app 'Host(`console.localhost`) && Host(`website.localhost`)'
} >"$answers"
jq -s --argjson taken "$taken" '$taken + {cases: .}' "$answers" >"$out"
# As `make check` would have it.
[ -n "${REFUSALS_OUT:-}" ] || pnpm exec biome format --write "$out" >/dev/null
jq -r '.cases[] | "\(.outcome)  \(.case): \(.message)"' "$out"
