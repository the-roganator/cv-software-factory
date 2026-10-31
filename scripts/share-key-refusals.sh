#!/usr/bin/env bash
# Asks the cluster, as `make share-key`'s user and as others, to make, change and delete the ConfigMap `share-key` in
# `website`, and keeps the answers of the `website-share-key` admission policy
# (deploy/base/admission/website/share-key.yaml) in deploy/test/share-key-refusals.json, with what the ConfigMap holds,
# which apps/factory/test/share-fences.test.ts holds to what each case must get. Run it with the policy on the cluster
# as `main` has it, and after `make share-key`, whenever the policy changes, with the local kubeconfig's own
# credentials (`system:admin`, which may impersonate the others), and a few seconds after a change: the API server
# takes a moment to load a policy.
#
# Each request is a server-side dry run: it passes through admission exactly as a real one does, and nothing is made,
# changed or deleted. A refusal must be the policy's; any other answer that is not a success (no connection, no
# `share-key`, an impersonation RBAC refuses) stops the script, so the record holds only the policy's own answers.
# Argo CD's application controller may do anything anywhere, so as it each request reaches admission.
#
#   admin-change     make share-key's user changes it, as the target does each time         admitted
#   admin-delete     make share-key's user deletes it                                       admitted
#   argocd-create    Argo CD's application controller makes it                              refused
#   argocd-change    Argo CD's application controller changes it                           refused
#   argocd-delete    Argo CD's application controller deletes it                            refused
#   argocd-other     Argo CD's application controller makes another ConfigMap in website   admitted
#   master-change    another member of system:masters changes it                            refused
#   master-delete    another member of system:masters deletes it                            refused
#
# Then what share-key holds: its keys, and whether its public key is the public half of the generator's Secret, so
# the record shows `make share-key` wrote it. The private key goes through a pipe and is never printed or kept.
#
# The record keeps the hash of the policy it was taken against (scripts/policy-hash.ts), which stops the script first
# unless the cluster runs it as deploy/ renders it here, and which apps/factory/test/refusal-records.test.ts holds to
# deploy/, so a change to it fails `make check` until this is run again.
set -euo pipefail

context="${KUBE_CONTEXT:-k3d-software-factory}"
kubectl=(kubectl --context "$context")
# REFUSALS_OUT writes the record elsewhere, as `make guardrails` takes it, and leaves deploy/test/ as it is.
out="${REFUSALS_OUT:-$(dirname "$0")/../deploy/test/share-key-refusals.json}"
policy="ValidatingAdmissionPolicy 'website-share-key'"
# The policies as the cluster runs them, or nothing asked (scripts/policy-hash.ts).
taken=$(node "$(dirname "$0")/policy-hash.ts" share-key-refusals)
argocd=(--as=system:serviceaccount:argocd:argocd-application-controller)
master=(--as=share-key-refusal --as-group=system:masters)

me=$("${kubectl[@]}" auth whoami -o jsonpath='{.status.userInfo.username}')
if [[ $me != system:admin ]]; then
  echo "Run this as make share-key's user, system:admin (the local kubeconfig's), not $me." >&2
  exit 1
fi

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

create() { # name as...: a server-side dry run of a ConfigMap of that name in website
  local name=$1
  shift
  "${kubectl[@]}" "$@" -n website create --dry-run=server -o name -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: $name
data:
  public-key: not a key
EOF
}
change() { "${kubectl[@]}" "$@" -n website patch configmap share-key --type merge --dry-run=server -o name -p '{"data":{"public-key":"not a key"}}'; }
delete() { "${kubectl[@]}" "$@" -n website delete configmap share-key --dry-run=server; }

# Kept aside until every case has answered, so a script that stops leaves the record as it was.
answers=$(mktemp)
trap 'rm -f "$answers"' EXIT
{
  try admin-change change
  try admin-delete delete
  try argocd-create create share-key "${argocd[@]}"
  try argocd-change change "${argocd[@]}"
  try argocd-delete delete "${argocd[@]}"
  try argocd-other create share-key-refusal "${argocd[@]}"
  try master-change change "${master[@]}"
  try master-delete delete "${master[@]}"
} >"$answers"

# What share-key holds, and whether it is the public half of the generator's key (the shell drops the PEM's last
# newline, which make share-key keeps).
held=$("${kubectl[@]}" -n website get configmap share-key -o json)
public=$("${kubectl[@]}" -n factory get secret share-signing-key -o jsonpath='{.data.private-key}' | base64 -d |
  node "$(dirname "$0")/share-key.ts" public)
live=$(jq -n --argjson held "$held" --arg public "$public" \
  '{keys: ($held.data // {} | keys), matchesSecret: ($held.data["public-key"] == $public + "\n")}')

jq -n --argjson taken "$taken" --slurpfile cases "$answers" --argjson live "$live" '$taken + {cases: $cases, live: $live}' >"$out"
# As `make check` would have it.
[ -n "${REFUSALS_OUT:-}" ] || pnpm exec biome format --write "$out" >/dev/null
jq -r '(.cases[] | "\(.outcome)  \(.case): \(.message)"), "share-key holds \(.live.keys | join(", ")); the public half of the Secret: \(.live.matchesSecret)"' "$out"
