#!/usr/bin/env bash
# Whether the merge queue still holds the entry a run was started for, so that a run on an entry the queue has let go
# stops instead of working on for nothing. Actions has no event for a queue branch going, and each queue branch's runs
# have a concurrency group of their own, so nothing else cancels them. It asks the remote anonymously (the repository is
# public): no token, and no credential helper, reaches git.
#
#   queue-branch-gone.sh        asks once, and prints one word:
#     there         the queue's branch is there.
#     merged        it is gone, because the entry merged: QUEUE_SHA is on BASE_REF.
#     gone          it is gone, and QUEUE_SHA is not on BASE_REF: the entry was ejected or removed. Exits 3.
#     unreachable   the remote did not answer, or not as expected (BASE_REF missing, a fetch that failed).
#   queue-branch-gone.sh watch  run as a step of a job. Outside the merge queue it says so and does nothing. In it, it
#                 leaves a watcher behind that asks once a minute for the rest of the job: it ends on merged, waits on
#                 there and unreachable, and on gone asks once more CONFIRM seconds later (the queue deletes a merged
#                 entry's branch after it moves BASE_REF, never before, but a moment's doubt costs nothing) and, gone
#                 still, stops the job's running step: one ::notice:: line in that step's log says why, then the step
#                 and every process under it get SIGTERM, and SIGKILL ten seconds later. The step fails, so the job and
#                 the run end failed, never passed, and the steps after it are skipped but those that run always.
#                 Only gone stops a run: a merged entry's runs go on as they would, and a remote that does not answer
#                 stops nothing.
#
# The job's steps are the children of the runner's Runner.Worker, an ancestor of the step that runs `watch`; in a job
# that runs in a container, which hides the runner, they are the processes `docker exec` started there, whose parent is
# outside it (0). A watcher that finds neither does not start, rather than guess.
#
# QUEUE_BRANCH (github.event.merge_group.head_ref), QUEUE_SHA (its head_sha) and BASE_REF (its base_ref) say what to
# ask about; REMOTE the repository (by default this run's, from GITHUB_SERVER_URL and GITHUB_REPOSITORY). INTERVAL
# (default 60) and CONFIRM (default 10) are in seconds. The watcher's log is WATCH_LOG (default
# $RUNNER_TEMP/queue-watch.log); its first line names its process. On gone it also leaves $RUNNER_TEMP/queue-gone, for
# a step that runs always to tell it stopped for that.
set -uo pipefail

INTERVAL=${INTERVAL:-60}
CONFIRM=${CONFIRM:-10}
TEMP=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
WATCH_LOG=${WATCH_LOG:-$TEMP/queue-watch.log}
REMOTE=${REMOTE:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}.git}
BASE_REF=${BASE_REF:-refs/heads/main}

# git that asks nothing of anyone: no credential, no prompt, and no call that outlasts 30 seconds.
quiet_git() {
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false timeout 30 git -c credential.helper= -c core.askPass=/bin/false "$@"
}

valid() {
  [[ ${QUEUE_BRANCH:-} =~ ^refs/heads/gh-readonly-queue/[A-Za-z0-9._/-]+$ ]] &&
    [[ ${QUEUE_SHA:-} =~ ^[0-9a-f]{40}$ ]] && [[ $BASE_REF =~ ^refs/heads/[A-Za-z0-9._/-]+$ ]]
}

# One word, as above.
ask() {
  local refs dir found
  if ! refs=$(quiet_git ls-remote "$REMOTE" "$BASE_REF" "$QUEUE_BRANCH" 2>/dev/null); then
    echo unreachable
    return
  fi
  # A remote that does not hold the base answered something else than the repository the run is for.
  if ! awk -v ref="$BASE_REF" '$2 == ref { found = 1 } END { exit !found }' <<<"$refs"; then
    echo unreachable
    return
  fi
  if awk -v ref="$QUEUE_BRANCH" '$2 == ref { found = 1 } END { exit !found }' <<<"$refs"; then
    echo there
    return
  fi
  # Gone: merged if the base's last commits hold the queue's, as the base moves to the queue's own commit when it
  # merges, and the queue merges a few entries at a time. Commits alone, no trees, into a repository of its own, so
  # the job's checkout is not touched.
  dir=$(mktemp -d)
  found=unreachable
  if git init -q --bare "$dir" &&
    quiet_git -C "$dir" fetch -q --no-tags --depth=50 --filter=tree:0 "$REMOTE" "$BASE_REF" 2>/dev/null; then
    if git -C "$dir" rev-list FETCH_HEAD | grep -qx "$QUEUE_SHA"; then found=merged; else found=gone; fi
  fi
  rm -rf "$dir"
  echo "$found"
}

# The process whose children are the job's steps: Runner.Worker among this one's ancestors; 0 in a container, where
# they are started from outside; nothing when it is neither.
steps_root() {
  local pid=$$ parent args
  while [ "$pid" -gt 1 ]; do
    args=$(ps -o args= -p "$pid" 2>/dev/null) || break
    args=${args%% *}
    if [ "${args##*/}" = Runner.Worker ]; then
      echo "$pid"
      return
    fi
    parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') || break
    if [ "$parent" = 0 ] && [ -e /.dockerenv ]; then
      echo 0
      return
    fi
    pid=${parent:-0}
  done
}

# Every process under the root but the root, pid 1 and this one, each step's own first.
under() {
  ps -A -o pid= -o ppid= | awk -v root="$1" -v self="$$" '
    { parent[$1] = $2; order[NR] = $1 }
    END {
      for (i = 1; i <= NR; i++) {
        p = order[i]
        if (p == 1 || p == 0 || p == self || p == root) continue
        for (q = p; q != "" && q != 0 && q != 1; q = parent[q]) if (parent[q] == root) { print p; break }
      }
    }'
}

stop_steps() {
  local root=$1 line=$2 pids pid steps
  # Newest first: the running step, before anything an earlier one left running.
  steps=$(ps -A -o pid= -o ppid= | awk -v root="$root" -v self="$$" '$2 == root && $1 != 1 && $1 != self { print $1 }' |
    sort -rn)
  pids=$(under "$root")
  # The notice goes to the running step's own output, the pipe the runner reads for its log and annotations (where
  # /proc shows it: on Linux).
  for pid in $steps; do
    [ -p "/proc/$pid/fd/1" ] || continue
    if { printf '%s\n' "$line" >"/proc/$pid/fd/1"; } 2>/dev/null; then break; fi
  done
  echo "$line"
  echo "stopping: $(echo $pids)"
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null
  sleep 10
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill -KILL $pids 2>/dev/null
}

loop() {
  local root=$1 state
  echo "watcher $$"
  while true; do
    state=$(ask)
    echo "$(date -u +%H:%M:%SZ) $state"
    case "$state" in
      merged) return 0 ;;
      gone)
        sleep "$CONFIRM"
        state=$(ask)
        echo "$(date -u +%H:%M:%SZ) $state, asked again"
        case "$state" in
          merged) return 0 ;;
          gone)
            : >"$TEMP/queue-gone"
            stop_steps "$root" "::notice::The merge queue let this entry go (${QUEUE_BRANCH#refs/heads/} is gone, and $QUEUE_SHA is not on ${BASE_REF#refs/heads/}): this run stops here, as its result would count for nothing."
            return 3
            ;;
        esac
        ;;
    esac
    sleep "$INTERVAL"
  done
}

watch() {
  local root
  if [ -z "${QUEUE_BRANCH:-}" ]; then
    echo "Not a run on the merge queue's commit: nothing to watch."
    return 0
  fi
  if ! valid; then
    echo "::warning::Not watching the merge queue's branch: '$QUEUE_BRANCH' at '${QUEUE_SHA:-}' onto '$BASE_REF' is not a queue entry's."
    return 0
  fi
  root=$(steps_root)
  if [ -z "$root" ]; then
    echo "::warning::Not watching the merge queue's branch: the job's steps were not found (no Runner.Worker, and not in a container)."
    return 0
  fi
  echo "Watching ${QUEUE_BRANCH#refs/heads/} once every ${INTERVAL}s: if it goes while $QUEUE_SHA is not on ${BASE_REF#refs/heads/}, this job stops (its log: $WATCH_LOG)."
  nohup "$0" _loop "$root" </dev/null >"$WATCH_LOG" 2>&1 &
}

case "${1:-}" in
  '')
    valid || { echo "QUEUE_BRANCH, QUEUE_SHA and BASE_REF must name a queue entry" >&2; exit 2; }
    state=$(ask)
    echo "$state"
    [ "$state" != gone ] || exit 3
    ;;
  watch) watch ;;
  _loop) loop "$2" ;;
  *) echo "usage: $0 [watch]" >&2; exit 2 ;;
esac
