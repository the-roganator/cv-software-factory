#!/usr/bin/env bash
# Aborts every release in flight that its stable version can take back: the second half of `make stop-the-line`, after
# the line has stopped its agents.
#
# A Rollout is mid-canary when the version it is rolling out (its current pod hash) is not yet its stable one, and it
# has not been aborted already. Aborting is a patch of the Rollout's status, `abort: true`, which is what Argo Rollouts'
# own `kubectl argo rollouts abort` does: the controller sends all traffic back to the stable version and scales the
# canary down. Nothing is rolled back in Git; the release stays aborted until the next one starts, or until Martin
# retries it, which is the same patch with `abort: false`.
#
# A canary whose stable version has no pod ready to serve is left alone, and the script says so: aborting it would send
# every request to a version that cannot serve one, as on the first release after the app is reset, whose stable
# version is one admission never let run. The stable version's pods are its ReplicaSet's available ones (Argo Rollouts
# names it `<rollout>-<stable hash>`); no such ReplicaSet has none. The release stays at its first step until promoted
# fully, as Argo Rollouts does not finish setting its first weight without a stable pod, and the script prints both the
# promotion and the abort to make by hand. A ReplicaSet it cannot read aborts nothing, and fails.
#
# It runs with Martin's own kubeconfig. The factory holds no right to change a Rollout: the line may only read them.
#
# KUBECTL is the kubectl command, with its context (the Makefile's). WAIT is how long to wait, in seconds, for each
# abort to take traffic off the canary (default 60).
set -euo pipefail

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
wait="${WAIT:-60}"

# Without Argo Rollouts there is nothing to abort; a cluster that cannot be asked is a failure, not an empty answer.
if ! found=$("${kubectl[@]}" get crd rollouts.argoproj.io -o name 2>&1); then
  if [[ "$found" == *NotFound* ]]; then
    echo "Argo Rollouts isn't installed, so no release is in flight."
    exit 0
  fi
  echo "Couldn't ask the cluster about releases: $found" >&2
  exit 1
fi

# One line per Rollout: namespace|name|stable hash|current hash|aborted.
rollouts=$("${kubectl[@]}" get rollouts --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}|{.metadata.name}|{.status.stableRS}|{.status.currentPodHash}|{.status.abort}{"\n"}{end}')

in_flight=0
failed=0
patched=()
# Every abort is sent before any is waited for, so a slow controller holds up no other release.
while IFS='|' read -r namespace name stable current abort; do
  [ -n "$name" ] || continue
  if [ -z "$stable" ] || [ "$stable" = "$current" ]; then continue; fi
  in_flight=$((in_flight + 1))
  if [ "$abort" = "true" ]; then
    echo "The release of $namespace/$name was aborted already."
    continue
  fi
  if ! available=$("${kubectl[@]}" -n "$namespace" get replicaset "$name-$stable" \
    -o jsonpath='{.status.availableReplicas}' 2>&1); then
    if [[ "$available" != *NotFound* ]]; then
      echo "Couldn't read the stable version of $namespace/$name, so its release wasn't aborted: $available" >&2
      failed=1
      continue
    fi
    available=0
  fi
  if [ "${available:-0}" = 0 ]; then
    echo "Didn't abort the release of $namespace/$name: its stable version has no pod ready to serve, so aborting it"
    echo "  would leave nothing to serve the app. It stays at its first step until promoted fully, which is yours:"
    echo "  ${kubectl[*]} -n $namespace patch rollout $name --subresource=status --type=merge -p '{\"status\":{\"promoteFull\":true}}'"
    echo "  Or to abort it all the same:"
    echo "  ${kubectl[*]} -n $namespace patch rollout $name --subresource=status --type=merge -p '{\"status\":{\"abort\":true}}'"
    continue
  fi
  if "${kubectl[@]}" -n "$namespace" patch rollout "$name" --subresource=status --type=merge \
    -p '{"status":{"abort":true}}' >/dev/null; then
    patched+=("$namespace/$name")
  else
    echo "Couldn't abort the release of $namespace/$name." >&2
    failed=1
  fi
done <<<"$rollouts"

# The controller takes the canary's traffic away first, then scales it down, and marks the Rollout Degraded.
for rollout in ${patched[@]+"${patched[@]}"}; do
  namespace=${rollout%%/*} name=${rollout#*/}
  if "${kubectl[@]}" -n "$namespace" wait "rollout/$name" --for=jsonpath='{.status.phase}'=Degraded \
    --timeout="${wait}s" >/dev/null 2>&1; then
    weights=$("${kubectl[@]}" -n "$namespace" get rollout "$name" \
      -o jsonpath='{.status.canary.weights.stable.weight}/{.status.canary.weights.canary.weight}')
    [ "$weights" != "/" ] || weights=""
    echo "Aborted the release of $rollout: the stable version takes all traffic${weights:+ (stable/canary $weights)}."
  else
    echo "Aborted the release of $rollout, but Argo Rollouts hasn't acted on it within ${wait}s." >&2
    failed=1
  fi
  echo "  It stays aborted until the next release starts. To retry this one:"
  echo "  ${kubectl[*]} -n $namespace patch rollout $name --subresource=status --type=merge -p '{\"status\":{\"abort\":false}}'"
done

if [ "$in_flight" = 0 ]; then echo "No release is in flight, so there is no canary to abort."; fi
exit "$failed"
