#!/usr/bin/env bash
# Runs a command, `make up`'s waits for Argo CD, and while it runs asks Argo CD every INTERVAL seconds (default 15) to
# refresh each Application that is Progressing, then exits as the command does.
#
# Argo CD refreshes an Application when a resource it tracks changes, and finds the Application from the resource's
# tracking label, which it does not put on a CRD (controller/cache/cache.go in Argo CD 3.6). So a CRD becoming
# Established refreshes nothing: an Application whose CRDs were Progressing at its last refresh stays Progressing until
# something else changes, or until Argo CD's own reconciliation, every two to three minutes. Kyverno and Argo Rollouts
# are the first sync waves, and each held the platform check's whole cluster so, for three and a half to four minutes
# (scripts/platform-timeline.sh named the CRDs). A normal refresh (the `argocd.argoproj.io/refresh` annotation, which
# Argo CD removes once it has refreshed) reads each resource's health again, from what its cache already holds; it
# changes nothing in the cluster, and root follows a child's health within a second.
#
# KUBECTL is the kubectl command, with its context (the Makefile's).
set -uo pipefail

read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"
interval=${INTERVAL:-15}

"$@" &
waited=$!
trap 'kill "$waited" 2>/dev/null' TERM INT

while kill -0 "$waited" 2>/dev/null; do
  sleep "$interval" &
  wait $! 2>/dev/null
  kill -0 "$waited" 2>/dev/null || break
  for app in $("${kubectl[@]}" -n argocd get applications --request-timeout=10s \
    -o jsonpath='{range .items[?(@.status.health.status=="Progressing")]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
    "${kubectl[@]}" -n argocd annotate application "$app" --overwrite --request-timeout=10s \
      argocd.argoproj.io/refresh=normal >/dev/null 2>&1 || true
  done
done
wait "$waited"
