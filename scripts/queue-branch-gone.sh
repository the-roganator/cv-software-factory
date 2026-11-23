#!/usr/bin/env bash
# Whether the merge queue still holds the entry a run was started for, so that a run on an entry the queue has let go
# stops instead of working on for nothing. Actions has no event for a queue branch going, and each queue branch's runs
# have a concurrency group of their own, so nothing else cancels them. It asks anonymously (the repository is public):
# no token, and no credential helper, reaches git or the API.
#
#   queue-branch-gone.sh        asks once, and prints one word:
#     there         the queue's branch is there, at QUEUE_SHA.
#     merged        it is gone, because the entry merged: QUEUE_SHA is on BASE_REF.
#     rebuilt       the queue made the entry's group again: its branch holds another commit now, or another queue branch
#                   holds the same pull request. The new group's runs stand for the entry, so this one's count for
#                   nothing. Exits 3.
#     gone          it is gone, QUEUE_SHA is not on BASE_REF, and the pull request's own record says the queue let it
#                   go: the last of its merge-queue events is a removal. Exits 3.
#     held          it is gone and QUEUE_SHA is not on BASE_REF, but the pull request's record says it is still in the
#                   queue. A branch is no proof by itself: GitHub's git has answered without the branch of an entry the
#                   queue held, and that read stopped runs whose entries then waited out their timeout.
#     unreachable   git or the API did not answer, or not as expected (BASE_REF missing, a fetch that failed).
#   queue-branch-gone.sh watch  run as a step of a job. Outside the merge queue it says so and does nothing. In it, it
#                 leaves a watcher behind that asks once a minute for the rest of the job: it ends on merged, waits on
#                 there, held and unreachable, and on gone or rebuilt asks once more CONFIRM seconds later and, still
#                 gone or rebuilt, stops the job's running step: one ::notice:: line in that step's log says why, then
#                 the step and every process under it get SIGTERM, and SIGKILL KILL_AFTER seconds later whatever of
#                 them is still there. The moment none is, it ends, and sends nothing more: the runner has gone on to
#                 the next step, which is not the watcher's to touch. The step fails, so the job and the run end
#                 failed, never passed, and the steps after it are skipped but those that run always. The first held
#                 answer puts one ::warning:: line in the running step's log, and stops nothing.
#
# The job's steps are the children of the runner's Runner.Worker, an ancestor of the step that runs `watch`; in a job
# that runs in a container, which hides the runner, they are the processes `docker exec` started there, whose parent is
# outside it (0). A watcher that finds neither does not start, rather than guess.
#
# QUEUE_BRANCH (github.event.merge_group.head_ref), QUEUE_SHA (its head_sha) and BASE_REF (its base_ref) say what to
# ask about; REMOTE the repository (by default this run's, from GITHUB_SERVER_URL and GITHUB_REPOSITORY), and API its
# REST API (by default from GITHUB_API_URL and GITHUB_REPOSITORY). INTERVAL (default 60), CONFIRM (default 10) and
# KILL_AFTER (default 10) are in seconds. The watcher's log is WATCH_LOG (default $RUNNER_TEMP/queue-watch.log): its
# first line names its process, then a line for each answer, the refs it read for each that is not there, and on a
# stop each process it signalled and how it ended. On gone or rebuilt it also leaves $RUNNER_TEMP/queue-gone, for a
# step that runs always to tell it stopped for that.
set -uo pipefail

INTERVAL=${INTERVAL:-60}
CONFIRM=${CONFIRM:-10}
KILL_AFTER=${KILL_AFTER:-10}
TEMP=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
WATCH_LOG=${WATCH_LOG:-$TEMP/queue-watch.log}
REMOTE=${REMOTE:-${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}.git}
API=${API:-${GITHUB_API_URL:-https://api.github.com}/repos/${GITHUB_REPOSITORY:-}}
BASE_REF=${BASE_REF:-refs/heads/main}

# git that asks nothing of anyone: no credential, no prompt, and no call that outlasts 30 seconds.
quiet_git() {
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false timeout 30 git -c credential.helper= -c core.askPass=/bin/false "$@"
}

# One page of the API, anonymously, into $1, its headers into $2.
quiet_get() {
  curl --silent --fail --max-time 20 --netrc-file /dev/null -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' -o "$1" -D "$2" "$3" 2>/dev/null
}

valid() {
  # The queue's branch for a pull request into main: check-kind.sh's QUEUE, with refs/heads/, as a test holds it.
  [[ ${QUEUE_BRANCH:-} =~ ^refs/heads/gh-readonly-queue/main/pr-([0-9]+)-[0-9a-f]{7,40}$ ]] &&
    [[ ${QUEUE_SHA:-} =~ ^[0-9a-f]{40}$ ]] && [[ $BASE_REF =~ ^refs/heads/[A-Za-z0-9._/-]+$ ]]
}

# Whether the pull request is in the queue, by its own record: `removed` when the last of its merge-queue events is a
# removal, `queued` when it is an addition, `unreachable` when the record cannot be read or holds neither. The timeline
# runs oldest first, so it reads the last page and, while that holds no such event, up to two before it.
queue_record() {
  local pr=${QUEUE_BRANCH##*/pr-} dir url last page event=
  pr=${pr%%-*}
  dir=$(mktemp -d) || { echo unreachable; return; }
  url="$API/issues/$pr/timeline?per_page=100"
  if quiet_get "$dir/1" "$dir/headers" "$url"; then
    last=$(tr -d '\r' <"$dir/headers" | grep -i '^link:' | grep -oE '[?&]page=[0-9]+>; rel="last"' | grep -oE '[0-9]+')
    last=${last:-1}
    for ((page = last; page >= 1 && page > last - 3; page--)); do
      [ -e "$dir/$page" ] || quiet_get "$dir/$page" "$dir/headers" "$url&page=$page" || break
      # The event names as the API writes them: a quote inside a string, such as a commit message's, is escaped.
      event=$(grep -oE '"event" *: *"(added_to|removed_from)_merge_queue"' "$dir/$page" | tail -1)
      [ -z "$event" ] || break
    done
  fi
  rm -rf "$dir"
  case "$event" in
    *removed_from_merge_queue*) echo removed ;;
    *added_to_merge_queue*) echo queued ;;
    *) echo unreachable ;;
  esac
}

# One word, as above, on its output; for each that is not there, what it read, on its error output (the watcher's log).
ask() {
  local refs at dir found commits
  if ! refs=$(quiet_git ls-remote "$REMOTE" "$BASE_REF" "${QUEUE_BRANCH%-*}-*" 2>/dev/null); then
    echo unreachable
    return
  fi
  # A remote that does not hold the base answered something else than the repository the run is for.
  if ! awk -v ref="$BASE_REF" '$2 == ref { found = 1 } END { exit !found }' <<<"$refs"; then
    echo unreachable
    return
  fi
  at=$(awk -v ref="$QUEUE_BRANCH" '$2 == ref { print $1 }' <<<"$refs")
  if [ "$at" = "$QUEUE_SHA" ]; then
    echo there
    return
  fi
  printf '  read: %s\n' "${refs//$'\n'/; }" >&2
  # The branch holds another commit, or another of the queue's branches holds this pull request: the queue made its
  # group again, on a new base or after it was added again, and that group's runs stand for it.
  if [ -n "$at" ] || awk -v prefix="${QUEUE_BRANCH%-*}-" 'index($2, prefix) == 1 { found = 1 } END { exit !found }' <<<"$refs"; then
    echo rebuilt
    return
  fi
  # Gone: merged if the base's history holds the queue's commit, as the base moves to the queue's own commit when it
  # merges. The whole history, not its last few commits, so a job run again long after its entry merged is not taken
  # for one let go. Commits alone, no trees (a few MB), into a repository of its own, so the job's checkout is not
  # touched.
  dir=$(mktemp -d)
  found=unreachable
  # The list is read whole before it is searched: piped to grep -q, which leaves at the first match, git would die of
  # SIGPIPE, and pipefail would take a merge for no match.
  if git init -q --bare "$dir" &&
    quiet_git -C "$dir" fetch -q --no-tags --filter=tree:0 "$REMOTE" "$BASE_REF" 2>/dev/null &&
    commits=$(git -C "$dir" rev-list FETCH_HEAD); then
    if grep -qx "$QUEUE_SHA" <<<"$commits"; then found=merged; else found=unmerged; fi
  fi
  rm -rf "$dir"
  if [ "$found" = unmerged ]; then
    # Not merged, and no branch: only the pull request's own record says whether the queue let it go.
    case "$(queue_record)" in
      removed) found=gone ;;
      queued) found=held ;;
      *) found=unreachable ;;
    esac
    echo "  the pull request's record: $found" >&2
  fi
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

# Puts a line in the running step's output, the pipe the runner reads for its log and annotations (where /proc shows
# it: on Linux), and says where it went.
tell() {
  local root=$1 line=$2 steps pid
  # Newest first: the running step, before anything an earlier one left running.
  steps=$(ps -A -o pid= -o ppid= | awk -v root="$root" -v self="$$" '$2 == root && $1 != 1 && $1 != self { print $1 }' |
    sort -rn)
  for pid in $steps; do
    [ -p "/proc/$pid/fd/1" ] || continue
    if { printf '%s\n' "$line" >"/proc/$pid/fd/1"; } 2>/dev/null; then
      echo "the line went to process $pid's output"
      return
    fi
  done
  echo "no step's output could be reached, so no line was made"
}

# Each process, a line each, for the log.
show() {
  [ -z "$1" ] || ps -o pid= -o ppid= -o args= -p "$(tr -s " \n" "," <<<"$1" | sed "s/,$//")" 2>/dev/null | sed 's/^/  /'
}

stop_steps() {
  local root=$1 line=$2 pids still i
  pids=$(under "$root")
  # Its own log says it without the command, so that printing the log makes no second notice.
  echo "${line#::notice::}"
  tell "$root" "$line"
  echo "stopping: ${pids//$'\n'/ }"
  show "$pids"
  # shellcheck disable=SC2086
  [ -z "$pids" ] || kill -TERM $pids 2>/dev/null
  # Then, a second at a time, whatever of them, or of what they started since, is still under the root: read again, so
  # a process forked while they ended is caught, and a number the system gave to another process since is not. None
  # left, the step is over and the runner has gone on to the next, so nothing more is sent.
  for ((i = 0; i < KILL_AFTER; i++)); do
    sleep 1
    still=$(left "$root" "${pids//$'\n'/ }")
    if [ -z "$still" ]; then
      echo "$(date -u +%H:%M:%SZ) every one ended on SIGTERM"
      return
    fi
  done
  echo "$(date -u +%H:%M:%SZ) killing what is left: ${still//$'\n'/ }"
  show "$still"
  # shellcheck disable=SC2086
  kill -KILL $still 2>/dev/null
}

# Each process under the root now that is one of those given or under one of them.
left() {
  ps -A -o pid= -o ppid= | awk -v root="$1" -v self="$$" -v given="$2" '
    BEGIN { n = split(given, g, /[[:space:]]+/); for (i = 1; i <= n; i++) if (g[i] != "") was[g[i]] = 1 }
    { parent[$1] = $2; order[NR] = $1 }
    END {
      for (i = 1; i <= NR; i++) {
        p = order[i]
        if (p == 1 || p == 0 || p == self || p == root) continue
        mine = 0
        for (q = p; q != "" && q != 0 && q != 1; q = parent[q]) {
          if (was[q]) mine = 1
          if (parent[q] == root) { if (mine) print p; break }
        }
      }
    }'
}

loop() {
  local root=$1 state warned='' branch=${QUEUE_BRANCH#refs/heads/} base=${BASE_REF#refs/heads/} pr
  pr=${QUEUE_BRANCH##*/pr-}
  pr=${pr%%-*}
  echo "watcher $$"
  while true; do
    state=$(ask)
    echo "$(date -u +%H:%M:%SZ) $state"
    case "$state" in
      merged) return 0 ;;
      held)
        if [ -z "$warned" ]; then
          warned=1
          tell "$root" "::warning::The merge queue's branch $branch was not there, but #$pr is still in the queue by its own record: this run goes on."
        fi
        ;;
      gone | rebuilt)
        sleep "$CONFIRM"
        state=$(ask)
        echo "$(date -u +%H:%M:%SZ) $state, asked again"
        case "$state" in
          merged) return 0 ;;
          gone)
            : >"$TEMP/queue-gone"
            stop_steps "$root" "::notice::The merge queue let this entry go ($branch is gone, $QUEUE_SHA is not on $base, and #$pr left the queue): this run stops here, as its result would count for nothing."
            return 3
            ;;
          rebuilt)
            : >"$TEMP/queue-gone"
            stop_steps "$root" "::notice::The merge queue made this entry's group again ($branch no longer holds $QUEUE_SHA): this run stops here, as the new group's run stands for it."
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
  echo "Watching ${QUEUE_BRANCH#refs/heads/} once every ${INTERVAL}s: if the queue lets this entry go, or makes its group again, this job stops (its log: $WATCH_LOG)."
  nohup "$0" _loop "$root" </dev/null >"$WATCH_LOG" 2>&1 &
}

case "${1:-}" in
  '')
    valid || { echo "QUEUE_BRANCH, QUEUE_SHA and BASE_REF must name a queue entry" >&2; exit 2; }
    state=$(ask)
    echo "$state"
    case "$state" in gone | rebuilt) exit 3 ;; esac
    ;;
  watch) watch ;;
  _loop) loop "$2" ;;
  *) echo "usage: $0 [watch]" >&2; exit 2 ;;
esac
