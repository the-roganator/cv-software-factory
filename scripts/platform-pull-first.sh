#!/usr/bin/env bash
# Argo CD's images, pulled into the platform check's node before `make up` installs Argo CD, each pull bounded and
# tried again. The hosted runner's one hang seen with its figures waited on the Argo CD install's hook pod, whose image
# never started to download (containerd had nothing in flight for half an hour), until the step's own limit; its cause
# is not known. Pulled here, each try is ended at LIMIT seconds by a timeout inside the node, which cancels the CRI
# pull itself, and tried again, up to TRIES; the pod then finds its image on the node and pulls nothing. The whole of it,
# the chart's read included, ends within DEADLINE seconds, which platform.yml's step gives room beyond (a test holds the
# sum), so it is this script, not the step's limit, that says which image did not pull.
#
#   platform-pull-first.sh
#
# Each image's tries, and how long each took, are said in the log. It fails, naming the image, when one never pulled.
# When Argo CD's images cannot be read (the chart's repository does not answer), it says so and pulls nothing first:
# `make up` then pulls them as it always has.
#
# CLUSTER_NODE is the node's container, TRIES and LIMIT the tries and each one's seconds, DEADLINE the seconds for the
# whole, IMAGES the images (one a line) in place of the chart's, for the tests.
set -uo pipefail

node=${CLUSTER_NODE:-k3d-software-factory-server-0}
tries=${TRIES:-3}
limit=${LIMIT:-45}
deadline=${DEADLINE:-420}
# A try ends inside the node at its limit; outside, `docker exec` is given MARGIN seconds more, then KILL more to go.
margin=10
kill=5

# <seconds> <command…>: the command, ended at its limit for certain, KILL seconds after SIGTERM at the latest.
bounded() { local seconds=$1; shift; timeout -k "$kill" "$seconds" "$@"; }

if [ -n "${IMAGES:-}" ]; then
  images=$IMAGES
else
  chart=$(sed -n 's/^ARGOCD_CHART := //p' Makefile)
  # Every image the chart renders with the cluster's values, its install hooks' among them.
  if ! images=$(bounded 45 helm template argocd argo-cd --repo https://argoproj.github.io/argo-helm --version "$chart" \
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
    # What is left of the deadline bounds the try, so the last one ends with the deadline rather than past it.
    left=$((deadline - SECONDS - margin - kill))
    if [ "$left" -lt 5 ]; then
      echo "::error::$image did not pull into the node within the ${deadline}s all of Argo CD's images have: the cluster cannot install Argo CD."
      exit 1
    fi
    this=$((left < limit ? left : limit))
    # The limit inside the node ends crictl, whose cancelled request ends containerd's pull; the one outside ends a
    # `docker exec` that does not answer.
    if out=$(bounded $((this + margin)) docker exec "$node" timeout "$this" crictl pull "$image" 2>&1); then
      echo "Pulled $image in $((SECONDS - started))s (try $try of $tries)."
      break
    fi
    last=$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)
    echo "$image did not pull in $((SECONDS - started))s (try $try of $tries): ${last:-no word}"
    if [ "$try" -ge "$tries" ]; then
      echo "::error::$image did not pull into the node in $tries tries of at most ${limit}s: the cluster cannot install Argo CD."
      exit 1
    fi
  done
done
