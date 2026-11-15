#!/usr/bin/env bash
# Where the platform check's time goes (.github/workflows/platform.yml): when each Application Argo CD deploys was made,
# first synced and last turned Healthy, when each pod was made, scheduled and ready, and each image the node pulled,
# how long it took, with and without the time it waited for the kubelet to start it, and its size.
# Every time is minutes and seconds after kube-system was made, which is when k3s started.
#
# Read from what the cluster keeps: the Applications' status, the pods' conditions, and the kubelet's Pulled events,
# which last an hour, longer than the check. A pod or a pull that went before the end (a Job's pod deleted, a pull
# that failed) is not in them. On the cluster (no arguments), it prints the tables and adds them to the step summary
# ($GITHUB_STEP_SUMMARY); KUBECTL is the kubectl command with its context, each read given READ_TIMEOUT (default 10s). It never fails the check: what it cannot
# read, it says.
#
# With four files, `kubectl get` of the kube-system namespace, and of Applications, pods and events in every
# namespace, as JSON, it prints the tables from them: the test's way in.
set -uo pipefail

# The tables, as Markdown, from the four files.
tables() { # namespace.json applications.json pods.json events.json
  jq -rn --slurpfile ns "$1" --slurpfile apps "$2" --slurpfile pods "$3" --slurpfile events "$4" '
    def epoch: sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601;
    ($ns[0].metadata.creationTimestamp | epoch) as $start |
    def at: if . == null then "-" else (epoch - $start) as $s | if $s < 0 then "-" else
      "+\($s / 60 | floor):\($s % 60 | tostring | if length < 2 then "0" + . else . end)" end end;
    def seconds: capture("in (?<pull>[0-9.]+)s \\((?<total>[0-9.]+)s including waiting\\)") // {};
    def mb: (capture("Image size: (?<bytes>[0-9]+) bytes") | .bytes | tonumber / 1e6 * 10 | round / 10) // null;
    def condition($type): [.status.conditions[]? | select(.type == $type and .status == "True") | .lastTransitionTime][0];
    def row: map(tostring) | "| " + join(" | ") + " |";
    [$events[0].items[] | select(.reason == "Pulled" and (.message | startswith("Successfully pulled"))) |
      (.message | capture("image \"(?<image>[^\"]+)\"").image) as $image | (.message | seconds) as $s |
      { image: $image, pod: "\(.involvedObject.namespace)/\(.involvedObject.name)",
        at: (.firstTimestamp // .eventTime), pull: ($s.pull // "0" | tonumber), total: ($s.total // "0" | tonumber),
        mb: (.message | mb) }] as $pulls |
    "### Applications",
    "",
    "| Application | Made | First synced | Last turned Healthy | Health |",
    "| --- | --- | --- | --- | --- |",
    ($apps[0].items | sort_by(.status.history[0].deployedAt // "~")[] |
      [.metadata.name, (.metadata.creationTimestamp | at), (.status.history[0].deployedAt | at),
       (.status.health.lastTransitionTime | at), (.status.health.status // "-")] | row),
    "",
    "### Pods",
    "",
    "Ready is the last time the pod turned ready; pulling is the seconds its own images took, without the wait.",
    "",
    "| Pod | Made | Scheduled | Ready | Pulling |",
    "| --- | --- | --- | --- | --- |",
    ($pods[0].items | map(. + { ready: condition("Ready") }) | sort_by(.ready // "~")[] |
      "\(.metadata.namespace)/\(.metadata.name)" as $pod |
      [$pod, (.metadata.creationTimestamp | at), (condition("PodScheduled") | at), (.ready | at),
       ([$pulls[] | select(.pod == $pod) | .pull] | add // 0 | . * 10 | round / 10 | tostring + "s")] | row),
    "",
    "### Pulls",
    "",
    "\($pulls | length) images, \([$pulls[].pull] | add // 0 | round)s of pulling, \([$pulls[].mb // 0] | add // 0 | round) MB.",
    "",
    "| Image | Done | Pulling | With the wait | Size |",
    "| --- | --- | --- | --- | --- |",
    ($pulls | sort_by(.at)[] |
      [.image, (.at | at), "\(.pull * 100 | round / 100)s", "\(.total * 100 | round / 100)s", (if .mb then "\(.mb) MB" else "-" end)] | row)'
}

if [ $# -eq 4 ]; then
  tables "$@"
  exit
fi

# Each read bounded, as platform-pods.sh's are: after a `make up` that failed, the API server may not answer at all.
read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
kubectl+=(--request-timeout="${READ_TIMEOUT:-10s}")
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
if ! "${kubectl[@]}" get namespace kube-system -o json > "$dir/ns.json" ||
  ! "${kubectl[@]}" -n argocd get applications -o json > "$dir/apps.json" ||
  ! "${kubectl[@]}" get pods -A -o json > "$dir/pods.json" ||
  ! "${kubectl[@]}" get events -A -o json > "$dir/events.json"; then
  echo "The cluster could not be read: no timeline."
  exit 0
fi
if ! out=$(tables "$dir/ns.json" "$dir/apps.json" "$dir/pods.json" "$dir/events.json"); then
  echo "The timeline could not be made from what the cluster holds."
  exit 0
fi
echo "$out"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '## Where the time went\n\n%s\n' "$out" >> "$GITHUB_STEP_SUMMARY"
