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
# version is one admission never let run (that release stays at its first step until promoted fully, as Argo Rollouts
# does not finish setting its first weight without a stable pod). It prints both the promotion and the abort to make by
# hand. Endpoints it cannot read abort nothing, and it fails.
#
# It runs with Martin's own kubeconfig. The factory holds no right to change a Rollout: the line may only read them.
#
# KUBECTL is the kubectl command, with its context (the Makefile's). WAIT is how long to wait, in seconds, for each
# abort to take traffic off the canary (default 60). STABLE_TRIES is how many times, a second apart, it looks for a
# stable pod ready to serve before it leaves a canary (default 3), so a moment's readiness blip aborts all the same.
set -euo pipefail

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
wait="${WAIT:-60}"
tries="${STABLE_TRIES:-3}"
if ! [[ "$tries" =~ ^[1-9][0-9]*$ ]]; then
  echo "STABLE_TRIES must be a whole number of looks, 1 or more, not '$tries'." >&2
  exit 1
fi

# Without Argo Rollouts there is nothing to abort; a cluster that cannot be asked is a failure, not an empty answer.
if ! found=$("${kubectl[@]}" get crd rollouts.argoproj.io -o name 2>&1); then
  if [[ "$found" == *NotFound* ]]; then
    echo "Argo Rollouts isn't installed, so no release is in flight."
    exit 0
  fi
  echo "Couldn't ask the cluster about releases: $found" >&2
  exit 1
fi

# Whether a pod of the stable version (hash $3) of Rollout $2 in namespace $1 is ready to serve: 0 if one is, 1 if
# none is, 2 if the app's endpoints cannot be read (said on stderr). The pods are the ready endpoints, not shutting
# down, of the namespace's Services whose pod is the stable version's, by name: Argo Rollouts names a version's
# ReplicaSet `<rollout>-<hash>`, and Kubernetes names its pods `<that>-<5 random>`, cutting what comes before them to 58
# characters. A name so long that the cut takes some of the hash cannot tell the versions apart: it is taken as ready,
# and the canary aborted, as before a stable pod was looked for. The admin service's Stop the line reads the same, by
# the same rule (apps/factory/src/admin/rollout.ts).
stable_ready() {
  local prefix="$2-$3-" said err kind pod ready terminating
  [ "${#prefix}" -le 58 ] || return 0
  err=$(mktemp)
  if ! said=$("${kubectl[@]}" -n "$1" get endpointslices -o jsonpath='{range .items[*].endpoints[*]}{.targetRef.kind}|{.targetRef.name}|{.conditions.ready}|{.conditions.terminating}{"\n"}{end}' 2>"$err"); then
    echo "Couldn't read the endpoints of $1, so the release of $1/$2 wasn't aborted: $(cat "$err")" >&2
    rm -f "$err"
    return 2
  fi
  rm -f "$err"
  while IFS='|' read -r kind pod ready terminating; do
    # Kubernetes says to read a ready condition it does not give as ready; one shutting down is not.
    if [ "${kind:-Pod}" = Pod ] && [[ -n "$pod" && "$pod" == "$prefix"* ]] && [ "$ready" != false ] &&
      [ "$terminating" != true ]; then
      return 0
    fi
  done <<<"$said"
  return 1
}

# One line per Rollout: namespace|name|stable hash|current hash|aborted.
rollouts=$("${kubectl[@]}" get rollouts --all-namespaces -o jsonpath='{range .items[*]}{.metadata.namespace}|{.metadata.name}|{.status.stableRS}|{.status.currentPodHash}|{.status.abort}{"\n"}{end}')

in_flight=0
failed=0
patched=()
# Rollouts whose stable version had no pod ready at the last look, as namespace|name|stable hash.
doubtful=()

abort() {
  if "${kubectl[@]}" -n "$1" patch rollout "$2" --subresource=status --type=merge \
    -p '{"status":{"abort":true}}' >/dev/null; then
    patched+=("$1/$2")
  else
    echo "Couldn't abort the release of $1/$2." >&2
    failed=1
  fi
}

# Looks for a stable pod of each Rollout given, and aborts each whose stable version has one; the rest are doubtful.
look() {
  local rollout namespace name stable ready
  doubtful=()
  for rollout in "$@"; do
    IFS='|' read -r namespace name stable <<<"$rollout"
    ready=0
    stable_ready "$namespace" "$name" "$stable" || ready=$?
    case "$ready" in
      0) abort "$namespace" "$name" ;;
      1) doubtful+=("$rollout") ;;
      *) failed=1 ;;
    esac
  done
}

# Every abort is sent before any is waited for, so a slow controller holds up no other release. A Rollout whose stable
# version has no pod ready is looked at again, a second apart, up to STABLE_TRIES looks in all, with the others: one
# that has a pod again is aborted then, and one that still has none at the last look is left.
candidates=()
while IFS='|' read -r namespace name stable current abort; do
  [ -n "$name" ] || continue
  if [ -z "$stable" ] || [ "$stable" = "$current" ]; then continue; fi
  in_flight=$((in_flight + 1))
  if [ "$abort" = "true" ]; then
    echo "The release of $namespace/$name was aborted already."
    continue
  fi
  candidates+=("$namespace|$name|$stable")
done <<<"$rollouts"
look ${candidates[@]+"${candidates[@]}"}
for ((try = 2; try <= tries && ${#doubtful[@]} > 0; try++)); do
  sleep 1
  look "${doubtful[@]}"
done
for rollout in ${doubtful[@]+"${doubtful[@]}"}; do
  IFS='|' read -r namespace name _ <<<"$rollout"
  echo "Didn't abort the release of $namespace/$name: its stable version has no pod ready to serve, so aborting it"
  echo "  would leave nothing to serve the app. Whether it goes out is yours. To promote it fully:"
  echo "  ${kubectl[*]} -n $namespace patch rollout $name --subresource=status --type=merge -p '{\"status\":{\"promoteFull\":true}}'"
  echo "  Or to abort it all the same:"
  echo "  ${kubectl[*]} -n $namespace patch rollout $name --subresource=status --type=merge -p '{\"status\":{\"abort\":true}}'"
done

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
