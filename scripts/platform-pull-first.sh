#!/usr/bin/env bash
# Argo CD's images, pulled into the platform check's node before `make up` installs Argo CD, each pull bounded and
# tried again. The hosted runner's one hang seen with its figures waited on the Argo CD install's hook pod, whose image
# never started to download (containerd had nothing in flight for half an hour), until the step's own limit; its cause
# is not known. Pulled here, each try is ended at LIMIT seconds by a timeout inside the node, which cancels the CRI
# pull itself, and tried again, up to TRIES; the pod then finds its image on the node and pulls nothing.
#
#   platform-pull-first.sh
#
# Each image's tries, and how long each took, are said in the log. It fails, naming the image, when one never pulled.
# When Argo CD's images cannot be read (the chart's repository does not answer), it says so and pulls nothing first:
# `make up` then pulls them as it always has.
#
# CLUSTER_NODE is the node's container, TRIES and LIMIT the tries and each one's seconds, IMAGES the images (one a
# line) in place of the chart's, for the tests.
set -uo pipefail

node=${CLUSTER_NODE:-k3d-software-factory-server-0}
tries=${TRIES:-3}
limit=${LIMIT:-75}

# <seconds> <command…>: the command, ended at its limit for certain.
bounded() { local seconds=$1; shift; timeout -k 5 "$seconds" "$@"; }

if [ -n "${IMAGES:-}" ]; then
  images=$IMAGES
else
  chart=$(sed -n 's/^ARGOCD_CHART := //p' Makefile)
  # Every image the chart renders with the cluster's values, its install hooks' among them.
  if ! images=$(bounded 60 helm template argocd argo-cd --repo https://argoproj.github.io/argo-helm --version "$chart" \
    --namespace argocd --values deploy/argocd/values.yaml |
    yq -N '.. | select(tag == "!!map") | select(has("image")) | .image | select(tag == "!!str")' | sort -u) ||
    [ -z "$images" ]; then
    echo "::warning::Argo CD's images could not be read from its chart $chart: none is pulled first, and the install pulls them."
    exit 0
  fi
fi

for image in $images; do
  for ((try = 1; ; try++)); do
    started=$SECONDS
    # The limit inside the node ends crictl, whose cancelled request ends containerd's pull; the one outside ends a
    # `docker exec` that does not answer.
    if out=$(bounded $((limit + 15)) docker exec "$node" timeout "$limit" crictl pull "$image" 2>&1); then
      echo "Pulled $image in $((SECONDS - started))s (try $try of $tries)."
      break
    fi
    last=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)
    echo "$image did not pull in $((SECONDS - started))s (try $try of $tries): ${last:-no word}"
    if [ "$try" -ge "$tries" ]; then
      echo "::error::$image did not pull into the node in $tries tries of ${limit}s: the cluster cannot install Argo CD."
      exit 1
    fi
  done
done
