#!/usr/bin/env bash
# The platform check's end (.github/workflows/platform.yml): whether every workload of the cluster it made is running
# and ready. Argo CD's health is not enough: a Deployment with no readiness probe counts as available each time its
# container starts, and is Degraded only after its progress deadline, later than the check ends.
#
# A pod is a fault, named with its reason, when any of these holds:
#   - a container (or an init container) is waiting: CrashLoopBackOff, an image it cannot pull, a config it cannot
#     read, or any other reason;
#   - a container is running and not ready;
#   - the pod is Pending (not scheduled, or not started), Failed or Unknown;
#   - a container last ended less than RECENT seconds ago (default 120): it is still restarting.
# A pod that has Succeeded is not a fault, nor is any pod of a Job that has completed: a Job's attempts that failed
# while what it needed came up (the migrations, while Postgres starts) are its own business once it succeeds. A pod of
# a Job not complete is judged as any other.
#
# The rule comes from the check's green runs: workers restart while Postgres and the migrations come up, the last of
# them three to eight minutes before the end, and a migration Job leaves failed attempts beside the one that ran.
# Restarts are not counted, only how recent the last one is.
#
# On the cluster (no arguments), it looks every INTERVAL seconds (default 10) for up to SETTLE seconds (default 180),
# and passes on the first look with no fault, so a worker that restarted a minute before is given time to show it has
# settled. Otherwise it names each pod and its reason, in the log and in the step summary ($GITHUB_STEP_SUMMARY), keeps
# each one's previous and current log and its `describe` in OUT (a directory, for the run's `cluster` artifact), and
# exits 1. KUBECTL is the kubectl command with its context.
#
# With two files, `kubectl get pods -A -o json` and `kubectl get jobs -A -o json` as recorded, it judges them once, as
# of NOW (seconds since the epoch; default now), prints the faults, and exits 1 if there are any: the test's way in.
set -uo pipefail

recent=${RECENT:-120}

# The faults, one line each, `namespace/pod: reason`, from pods and jobs as JSON, as of `now`.
judge() { # pods.json jobs.json now
  jq -rn --slurpfile pods "$1" --slurpfile jobs "$2" --argjson now "$3" --argjson recent "$recent" '
    ([$jobs[0].items[] | select(any(.status.conditions[]?; .type == "Complete" and .status == "True"))
      | "\(.metadata.namespace)/\(.metadata.name)"]) as $complete |
    def ended: (.lastState.terminated.finishedAt // empty | fromdateiso8601);
    def waiting($kind): select(.state.waiting) |
      "\($kind) \(.name) waiting: \(.state.waiting.reason // "unknown")\(.state.waiting.message // "" | if . == "" then "" else ": " + (split("\n")[0]) end)";
    $pods[0].items[] | . as $pod | "\(.metadata.namespace)/\(.metadata.name)" as $name |
    select(.status.phase != "Succeeded") |
    select([.metadata.ownerReferences[]? | select(.kind == "Job") | "\($pod.metadata.namespace)/\(.name)"]
      | any(IN($complete[])) | not) |
    [
      (.status.initContainerStatuses[]? | waiting("init container")),
      (.status.containerStatuses[]? | waiting("container")),
      (.status.containerStatuses[]? | select(.state.running and (.ready | not)) | "container \(.name) running, not ready"),
      (.status.containerStatuses[]? | ended as $at | select($now - $at < $recent) |
        "container \(.name) restarted \($now - $at | floor)s ago (\(.restartCount) restarts; last exit \(.lastState.terminated.exitCode), \(.lastState.terminated.reason // "unknown"))"),
      (select(.status.phase == "Pending" and ([.status.containerStatuses[]?, .status.initContainerStatuses[]? | select(.state.waiting)] | length == 0)) |
        "Pending: \([.status.conditions[]? | select(.status != "True") | "\(.type) \(.reason // "") \(.message // "")"] | join("; ") | if . == "" then "not started" else . end)"),
      (select(.status.phase == "Failed" or .status.phase == "Unknown") |
        "\(.status.phase)\([.status.reason, .status.message] | map(select(. != null and . != "")) | if length > 0 then ": " + join(" ") else "" end)")
    ] | select(length > 0) | "\($name): \(join("; "))"'
}

if [ $# -eq 2 ]; then
  faults=$(judge "$1" "$2" "${NOW:-$(date +%s)}") || exit 2
  [ -z "$faults" ] && exit 0
  printf '%s\n' "$faults"
  exit 1
fi

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
kubectl+=(--request-timeout="${READ_TIMEOUT:-10s}")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
deadline=$((SECONDS + ${SETTLE:-180}))
while true; do
  if "${kubectl[@]}" get pods -A -o json >"$work/pods.json" && "${kubectl[@]}" get jobs -A -o json >"$work/jobs.json"; then
    faults=$(judge "$work/pods.json" "$work/jobs.json" "$(date +%s)") || faults="the pods could not be judged"
  else
    faults="the cluster could not be read"
  fi
  [ -z "$faults" ] && { echo "Every pod is running and ready, and none restarted in the last ${recent} seconds."; exit 0; }
  ((SECONDS >= deadline)) && break
  sleep "${INTERVAL:-10}"
done

echo "Not running and ready after ${SETTLE:-180} seconds more:"
sed 's/^/  /' <<<"$faults"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Pods not running and ready"; echo; sed 's/.*/- `&`/' <<<"$faults"; } >>"$GITHUB_STEP_SUMMARY"
fi
# Each pod's logs, its previous container's too, and its description, for the artifact.
if [ -n "${OUT:-}" ]; then
  mkdir -p "$OUT"
  while IFS= read -r line; do
    pod=${line%%: *}
    [[ $pod == */* ]] || continue
    file="$OUT/${pod//\//_}"
    "${kubectl[@]}" -n "${pod%%/*}" describe pod "${pod#*/}" >"$file.describe.txt" 2>&1
    "${kubectl[@]}" -n "${pod%%/*}" logs "${pod#*/}" --all-containers --tail=200 >"$file.log" 2>&1
    "${kubectl[@]}" -n "${pod%%/*}" logs "${pod#*/}" --all-containers --previous --tail=200 >"$file.previous.log" 2>&1
  done <<<"$faults"
fi
exit 1
