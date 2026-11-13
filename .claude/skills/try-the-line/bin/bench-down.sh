#!/usr/bin/env bash
# Takes the bench down (`make bench-down`): undoes what the try-the-line skill's bench starts, and says what it removed.
#   - The host gateway the bench runs on 127.0.0.1:8180 (BENCH_PORT): stopped only if what listens there is the
#     factory's gateway (`cli.ts gateway` on its command line) run from this checkout or one of its worktrees (its
#     working directory, as lsof gives it); anything else there is named and left.
#   - The bench's throwaway Postgres containers, every container named sf-bench-*: first what its model calls cost,
#     for the run's notes, then removed with their data.
# The cassettes it recorded (/tmp/bench-cassettes) stay: a step run again replays from them.
# Exit 0 once nothing of the bench is left; 1 if something could not be stopped or removed.
set -uo pipefail
port=${BENCH_PORT:-8180} removed=0 failed=0
# Whether the pid runs: one that has ended and waits for its parent to read its status has stopped.
running() { local stat; stat=$(ps -p "$1" -o stat= 2>/dev/null) && [[ $stat != Z* ]]; }
# This checkout and each of its worktrees, a line each, as real paths.
common=$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)
checkouts=$(git -C "$common/.." worktree list --porcelain | sed -n 's/^worktree //p' |
  while IFS= read -r path; do (cd "$path" 2>/dev/null && pwd -P); done)
# ours <pid>: whether the process works in this checkout or one of its worktrees.
ours() {
  local cwd
  cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
  [[ -n $cwd ]] && grep -qxF "$cwd" <<<"$checkouts"
}

for pid in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
  command=$(ps -p "$pid" -o command= 2>/dev/null)
  if [[ $command == *cli.ts\ gateway* ]] && ! ours "$pid"; then
    echo "Left pid $pid on port $port: a gateway, but not run from this checkout or its worktrees ($command)."
  elif [[ $command == *cli.ts\ gateway* ]]; then
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do running "$pid" || break; sleep 0.5; done
    if running "$pid"; then echo "The bench's gateway (pid $pid, port $port) did not stop: kill $pid"; failed=1
    else echo "Stopped the bench's gateway: pid $pid on port $port."; removed=$((removed + 1)); fi
  else
    echo "Left pid $pid on port $port: it is not the factory's gateway ($command)."
  fi
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running, so no bench container is running either."
else
  for name in $(docker ps -a --format '{{.Names}}' | grep '^sf-bench-'); do
    cost=$(docker exec "$name" psql -U factory -d factory -At -c \
      "select count(*) || ' model calls, $' || round(coalesce(sum(cost_usd), 0), 2) from model_calls" 2>/dev/null)
    if docker rm -f "$name" >/dev/null; then
      echo "Removed the container $name${cost:+ (it recorded $cost)}."; removed=$((removed + 1))
    else
      echo "Could not remove the container $name: docker rm -f $name"; failed=1
    fi
  done
fi

(( removed || failed )) || echo "Nothing of the bench was running."
exit $failed
