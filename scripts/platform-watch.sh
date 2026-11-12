#!/usr/bin/env bash
# Watches the cluster platform.yml makes while `make up` waits for it, and says when to stop waiting: the platform
# check's ceiling, and the two faults that waiting longer will not mend. It prints one line and exits 1 on the first of:
#
#   ceiling      DEADLINE seconds (default 1200) have passed since it started: the cluster did not come up in time. It
#                names each Application not yet Synced and Healthy, and each of its resources that is not.
#   comparison   an Application has a ComparisonError (Argo CD could not render it: a chart or its values that do not
#                render, a revision it cannot fetch) that outlasts a hard refresh. Argo CD keeps the condition, and the
#                repo server the failed render, until its next resync, minutes later; so on first seeing one it asks
#                for a hard refresh, which renders again now, and stops only if the error is still there once
#                `reconciledAt` has moved past it. A fetch that failed once while the repo server started clears.
#   degraded     an Application has stayed Degraded for DEGRADED seconds (default 300). While a cluster comes up a pod
#                may crash until what it needs is ready; its Deployment is Progressing meanwhile, and Degraded only
#                once its progress deadline has passed, so one Degraded for five more minutes is not coming up.
#                Restarts are not counted: a pod that cannot pull its image has none.
#                The website's health is its release's, and root's rolls it up (scripts/wait-deployed.sh): neither is
#                judged so.
#
# On first seeing a ComparisonError it says so, and that it asked for a refresh, on stderr, with when Argo CD compared.
# It exits 0 once WATCHED, the process it watches, has ended. KUBECTL is the kubectl command with its context.
set -uo pipefail

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
# Every request to the API ends within READ_TIMEOUT (default 10s), so an API that does not answer cannot hold the watch
# past its ceiling. A read that fails or times out tells it nothing: no Application is taken for healthy, nor for broken.
kubectl+=(--request-timeout="${READ_TIMEOUT:-10s}")
deadline=$((SECONDS + ${DEADLINE:-1200}))
interval=${INTERVAL:-15}
degraded_for=${DEGRADED:-300}
# What it has seen of each Application, a file each: when it was first seen Degraded, and when Argo CD last compared
# it, if that comparison found a ComparisonError.
seen=$(mktemp -d)
trap 'rm -rf "$seen"' EXIT

while [ -z "${WATCHED:-}" ] || kill -0 "$WATCHED" 2>/dev/null; do
  if ((SECONDS >= deadline)); then
    echo "ceiling: the cluster did not come up within ${DEADLINE:-1200} seconds. Not yet Synced and Healthy:"
    "${kubectl[@]}" -n argocd get applications -o json 2>/dev/null | jq -r '.items[] |
      select(.status.sync.status != "Synced" or .status.health.status != "Healthy") | .metadata.name as $app |
      "  \($app) \(.status.sync.status // "Unknown") \(.status.health.status // "Unknown")",
      (.status.resources[]? | select(.status != "Synced" or (.health.status // "Healthy") != "Healthy") |
        "    \(.kind)/\(.namespace // "")/\(.name) \(.status) \(.health.status // "") \(.health.message // "")")'
    exit 1
  fi
  # One line per Application: its name, its health, how many ComparisonErrors it has now, when it was compared, and
  # the first error's message, last, as the rest of the line.
  states=$("${kubectl[@]}" -n argocd get applications -o json 2>/dev/null | jq -r '.items[] |
    [.status.conditions[]? | select(.type == "ComparisonError") | .message | gsub("\n"; " ")] as $errors |
    "\(.metadata.name) \(.status.health.status // "Unknown") \($errors | length) \(.status.reconciledAt // "never") \($errors[0] // "")"' || true)
  while read -r app health errors compared message; do
    [ -n "$app" ] || continue
    if [ "$errors" -gt 0 ]; then
      if [ -e "$seen/$app.compared" ] && [ "$(<"$seen/$app.compared")" != "$compared" ]; then
        echo "comparison: Argo CD cannot render $app:"
        echo "  $message"
        exit 1
      fi
      if [ ! -e "$seen/$app.compared" ]; then
        echo "$compared" >"$seen/$app.compared"
        "${kubectl[@]}" -n argocd annotate application "$app" argocd.argoproj.io/refresh=hard --overwrite >/dev/null 2>&1 || true
        echo "$app: a ComparisonError at its comparison of $compared; asked for a hard refresh" >&2
      fi
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
