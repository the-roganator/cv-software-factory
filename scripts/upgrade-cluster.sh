#!/usr/bin/env bash
# Moves a local k3d cluster to the k3s image its config pins, keeping everything in it: `make upgrade-cluster`.
#
#   scripts/upgrade-cluster.sh <cluster> <config>          move it to the config's k3s
#   scripts/upgrade-cluster.sh <cluster> <config> back     go back to the copy the last move took first
#
# k3d cannot change a node's image: a node is a container, and a new k3s is a new container. So the cluster's state
# lives off the node, as on a managed cluster: k3s's data directory (/var/lib/rancher/k3s: its datastore with every
# Secret and the feature flags, its certificates, and the local-path volumes with the event store and the artifacts)
# is the Docker volume `k3d-<cluster>-state`, which `make up` makes before the cluster and k3d does not delete with
# it. A move is then k3s's own upgrade: the server stops, the new k3s starts on the same data directory, with the same
# token. A cluster made before the volume keeps its state on the volume Docker made for the node; the first move
# copies it to the state volume.
#
# Nothing is lost but the node's image cache (agent/containerd), which the new k3s pulls again, so images imported
# with `k3d image import` go; the telemetry's history is kept with the rest. Before the move it copies the data
# directory, again without the image cache, to `k3d-<cluster>-state-before-<tag>`, which `back` restores; the copy
# stays in Docker, beside the state itself, and never becomes a file on the Mac. The proof is built in: it takes the
# figures scripts/cluster-figures.ts names before it stops the cluster and once the new one serves the store, and
# calls the move done only when they match; then it deletes the copy, unless KEEP=1. When they do not match, or a step
# fails, the copy is kept and it says how to go back.
#
# It refuses while the line runs, which would move what it compares. The figures, which hold counts and digests and
# no content, and the config with the cluster's token, are kept for the move in
# ~/.config/software-factory/cluster-upgrade/<cluster>/, readable by Martin alone, and deleted when it is done.
set -euo pipefail

cluster=${1:?cluster} config=${2:?config} mode=${3:-upgrade}
context=k3d-$cluster
node=k3d-$cluster-server-0
state=k3d-$cluster-state
label=software-factory.cluster=$cluster
dir=${CLUSTER_UPGRADE_DIR:-$HOME/.config/software-factory/cluster-upgrade}/$cluster
here=$(cd "$(dirname "$0")" && pwd)
want=$(sed -nE 's/^image: *([^ ]+).*$/\1/p' "$config")
[[ -n "$want" ]] || { echo "$config names no image." >&2; exit 1; }

umask 077
mkdir -p "$dir"
chmod 700 "$dir"
trap 'rm -f "$dir/cluster.yaml"' EXIT

say() { printf '  %s\n' "$*"; }
# One top-level field of a figures file.
field() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]))' "$1" "$2"; }
exists() { docker volume inspect "$1" >/dev/null 2>&1; }
running() { k3d cluster list "$cluster" >/dev/null 2>&1; }

# The copies a move kept of this cluster's state: a move refuses to start while one is kept, so there is one at most.
copies() { docker volume ls -q --filter "label=$label" --filter label=software-factory.backup; }

# The way back, said whenever the move stops short.
way_back() {
  echo >&2
  if [[ -n "${backup:-}" ]] && exists "$backup"; then
    echo "The cluster's data directory as it was before the move is kept in the Docker volume $backup." >&2
    echo "  Go back to it: make upgrade-cluster BACK=1 (on the k3s it was made on, $(docker volume inspect -f '{{index .Labels "software-factory.k3s"}}' "$backup"))." >&2
  else
    echo "No copy of the state from before the move is kept: the state volume, $state, is all there is." >&2
  fi
  if [[ -f "$dir/before.json" ]]; then
    echo "  Or, once what stopped it is put right, run make upgrade-cluster again: it carries on from the state it kept." >&2
  fi
}

# Copies one volume's k3s data directory to another, without the image cache, in a container with no network.
copy() {
  docker run --rm --network none --entrypoint /bin/sh -v "$1:/from:ro" -v "$2:/to" "$want" \
    -c 'set -o pipefail; cd /from && tar --exclude=./agent/containerd -cf - . | tar -C /to -xf -'
}

# Makes the cluster again on the state volume, with the k3s image given and the token its data directory was made
# with (k3s refuses its own data under another). The token goes through a file only Martin may read, never a command.
create() {
  local image=$1 token
  # Each step returns on failure itself: callers run this after `||`, where `set -e` does not hold.
  token=$(docker run --rm --network none --entrypoint cat -v "$state:/state:ro" "$want" /state/server/token) || return 1
  [[ -n "$token" ]] || { echo "The state volume holds no token: it is not a k3s data directory." >&2; return 1; }
  { sed -E "s|^image: .*$|image: $image|" "$config"; printf 'token: %s\n' "$token"; } >"$dir/cluster.yaml" || return 1
  k3d cluster create --config "$dir/cluster.yaml" || { rm -f "$dir/cluster.yaml"; return 1; }
  rm -f "$dir/cluster.yaml"
  say "Waiting for the node, then for the store's Postgres (images are pulled again: a few minutes)..."
  kubectl --context "$context" wait node --all --for=condition=Ready --timeout=5m >/dev/null || return 1
  # The pod's status in the datastore is still the one from before the move, so ask Postgres itself, for at most 15
  # minutes: it answers once its image is pulled again and it has started on the volume it had.
  local tries=0
  until kubectl --context "$context" -n factory exec postgres-0 -- pg_isready -q -U factory -d factory >/dev/null 2>&1; do
    ((++tries < 180)) || { echo "The store's Postgres has not answered in 15 minutes." >&2; return 1; }
    sleep 5
  done
}

# Takes the figures again and holds them to the ones taken before the move.
prove() {
  local upto
  upto=$(field "$dir/before.json" lastSeq) || return 1
  node "$here/cluster-figures.ts" take "$context" --upto "$upto" >"$dir/after.json" || return 1
  node "$here/cluster-figures.ts" compare "$dir/before.json" "$dir/after.json"
}

# The move is proved: the figures go, and the copy taken first too, unless KEEP=1.
finish() {
  rm -f "$dir/before.json" "$dir/after.json"
  if [[ -n "${KEEP:-}" ]]; then
    say "Moved to $want. The copy is kept (KEEP=1): 'docker volume rm $backup' deletes it, 'make upgrade-cluster BACK=1' goes back to it."
  else
    docker volume rm "$backup" >/dev/null
    say "Moved to $want, and the copy taken first deleted."
  fi
}

if [[ "$mode" == back ]]; then
  backup=$(copies)
  [[ -n "$backup" ]] || { echo "No copy of $cluster's state to go back to." >&2; exit 1; }
  [[ "$backup" != *$'\n'* ]] || { echo "More than one copy of $cluster's state is kept, and BACK=1 will not choose: $(echo $backup)." >&2; exit 1; }
  was=$(docker volume inspect -f '{{index .Labels "software-factory.k3s"}}' "$backup")
  # Going back with the line running would take the work in flight back with it.
  if running && [[ "$(node "$here/cluster-figures.ts" take "$context" | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).line)')" == started ]]; then
    echo "The line is running, and going back would take its work in flight back too. Stop it first: make stop-the-line REASON=\"k3s upgrade\"" >&2
    exit 1
  fi
  echo "Going back to $backup, on $was."
  # What the cluster holds now, and has made since the move, is kept too, never deleted by going back.
  left=$state-left-$(date -u +%Y%m%dT%H%M%SZ)
  if running; then k3d cluster stop "$cluster"; fi
  if exists "$state"; then
    say "Keeping the state it replaces, with everything made since the move, as $left."
    docker volume create --label "$label" "$left" >/dev/null
    copy "$state" "$left"
  fi
  if running; then k3d cluster delete "$cluster"; fi
  if exists "$state"; then docker volume rm "$state" >/dev/null; fi
  docker volume create --label "$label" "$state" >/dev/null
  copy "$backup" "$state"
  create "$was" || exit 1
  if [[ -f "$dir/before.json" ]]; then
    prove || { way_back; exit 1; }
    rm -f "$dir/before.json" "$dir/after.json"
  fi
  say "Back on $was, the copy kept: 'docker volume rm $backup' deletes it once you are done with it."
  if exists "$left"; then say "What it replaced is kept as $left: 'docker volume rm $left' deletes it."; fi
  exit 0
fi

if ! running; then
  # A move that stopped after the cluster was deleted: the state volume holds everything, so make the cluster again.
  if exists "$state" && [[ -f "$dir/before.json" ]]; then
    backup=$(copies | head -1)
    say "No cluster, but its state from a move that stopped: making it again on $want."
    create "$want" || { way_back; exit 1; }
    prove || { way_back; exit 1; }
    finish
    exit 0
  fi
  echo "There is no cluster $cluster: 'make up' makes one." >&2
  exit 1
fi

have=$(docker inspect -f '{{.Config.Image}}' "$node")
source=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/rancher/k3s"}}{{.Name}}{{end}}{{end}}' "$node")
[[ -n "$source" ]] || { echo "$node keeps no volume at /var/lib/rancher/k3s; nothing to carry." >&2; exit 1; }
if [[ "$have" == "$want" && "$source" == "$state" ]]; then
  # A move that stopped before its figures matched leaves them: it is not done until they do.
  if [[ -f "$dir/before.json" ]]; then
    backup=$(copies | head -1)
    say "$cluster runs $want, from a move whose figures have not matched yet: taking them again."
    prove || { way_back; exit 1; }
    finish
    exit 0
  fi
  echo "$cluster already runs $want, its state on $state."
  exit 0
fi
kept=$(copies)
if [[ -n "$kept" ]]; then
  echo "A copy from an earlier move is still kept, $(echo $kept). Go back to it (make upgrade-cluster BACK=1), or delete it (docker volume rm $(echo $kept)), first." >&2
  exit 1
fi
backup=$state-before-${have##*:}
if [[ "$source" != "$state" ]] && exists "$state"; then
  echo "$state exists but this cluster does not use it: it is left from another cluster. Delete it (docker volume rm $state) first." >&2
  exit 1
fi

echo "Moving $cluster from $have to $want, keeping everything in it."
say "Not kept: the node's image cache, which the new k3s pulls again (and any image imported with 'k3d image import')."
docker pull -q "$want" >/dev/null
node "$here/cluster-figures.ts" take "$context" >"$dir/before.json"
line=$(field "$dir/before.json" line)
if [[ "$line" == started ]]; then
  echo "The line is running, and would move what the move is checked on. Stop it first: make stop-the-line REASON=\"k3s upgrade\"" >&2
  rm -f "$dir/before.json"
  exit 1
fi
say "Before: last seq $(field "$dir/before.json" lastSeq), the line $line."

say "Stopping the cluster, and copying its state (a few minutes)..."
k3d cluster stop "$cluster"
# Until the cluster is deleted, a failure leaves it as it was, stopped, and the copies made so far go.
unmade() {
  echo "The copy failed. The cluster is as it was, stopped: 'k3d cluster start $cluster' starts it." >&2
  docker volume rm "$backup" >/dev/null 2>&1 || true
  if [[ "$source" != "$state" ]]; then docker volume rm "$state" >/dev/null 2>&1 || true; fi
  rm -f "$dir/before.json"
  exit 1
}
docker volume create --label "$label" --label software-factory.backup=true --label "software-factory.k3s=$have" "$backup" >/dev/null
copy "$source" "$backup" || unmade
if [[ "$source" != "$state" ]]; then
  docker volume create --label "$label" "$state" >/dev/null
  copy "$source" "$state" || unmade
fi

say "Making the cluster again on $want, on its state..."
k3d cluster delete "$cluster"
create "$want" || { way_back; exit 1; }
prove || { way_back; exit 1; }

finish
