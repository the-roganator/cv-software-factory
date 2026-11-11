#!/usr/bin/env bash
# Watches the cluster platform.yml makes while `make up` waits for it, and says when to stop waiting: the platform
# check's ceiling, and the two faults that waiting longer will not mend. It prints one line and exits 1 on the first of:
#
#   ceiling      DEADLINE seconds (default 1200) have passed since it started: the cluster did not come up in time.
#   comparison   an Application has had a ComparisonError (Argo CD could not render it: a chart or its values that do
#                not render, a revision it cannot fetch) on two looks in a row, INTERVAL seconds apart (default 15), so
#                a fetch that fails once while the repo server starts is not taken for the change's fault.
#   degraded     an Application has stayed Degraded for DEGRADED seconds (default 300). While a cluster comes up a pod
#                may crash until what it needs is ready, and its Application is Degraded meanwhile; one Degraded for
#                five minutes is not coming up. Restarts are not counted: a pod that cannot pull its image has none.
#                The website's health is its release's, and root's rolls it up (scripts/wait-deployed.sh): neither is
#                judged so.
#
# It exits 0 once WATCHED, the process it watches, has ended. KUBECTL is the kubectl command with its context.
set -uo pipefail

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
deadline=$((SECONDS + ${DEADLINE:-1200}))
interval=${INTERVAL:-15}
degraded_for=${DEGRADED:-300}
# What it has seen of each Application, a file each: when it was first seen Degraded, and whether the last look found
# a ComparisonError.
seen=$(mktemp -d)
trap 'rm -rf "$seen"' EXIT

while [ -z "${WATCHED:-}" ] || kill -0 "$WATCHED" 2>/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "ceiling: the cluster did not come up within ${DEADLINE:-1200} seconds"
    exit 1
  fi
  # One line per Application: its name, its health, and how many ComparisonErrors it has now.
  states=$("${kubectl[@]}" -n argocd get applications -o json 2>/dev/null | jq -r '.items[] |
    "\(.metadata.name) \(.status.health.status // "Unknown") \([.status.conditions[]? | select(.type == "ComparisonError")] | length)"' || true)
  while read -r app health errors; do
    [ -n "$app" ] || continue
    if [ "$errors" -gt 0 ]; then
      if [ -e "$seen/$app.compared" ]; then
        echo "comparison: Argo CD cannot render $app:"
        "${kubectl[@]}" -n argocd get application "$app" -o json |
          jq -r '.status.conditions[]? | select(.type == "ComparisonError") | "  \(.message)"'
        exit 1
      fi
      touch "$seen/$app.compared"
    else
      rm -f "$seen/$app.compared"
    fi
    if [ "$health" = Degraded ] && [ "$app" != website ] && [ "$app" != root ]; then
      [ -e "$seen/$app.degraded" ] || echo "$SECONDS" >"$seen/$app.degraded"
      since=$(<"$seen/$app.degraded")
      if ((SECONDS - since >= degraded_for)); then
        echo "degraded: $app has been Degraded for $((SECONDS - since)) seconds"
        exit 1
      fi
    else
      rm -f "$seen/$app.degraded"
    fi
  done <<<"$states"
  sleep "$interval"
done
exit 0
