#!/usr/bin/env bash
# Waits on a pull request's CI, the one way a session does: wait-ci.sh <pr> [key]
# The key names the repository, as in repo.sh: an app- key's pull request is in the app's; without one, this one's, and
# it refuses to run in another repository's checkout, where a bare number would name the wrong pull request.
# An open pull request that conflicts with its base runs no CI worth waiting for: said at once. Otherwise every check on
# the head is read every 30 seconds, and a line of counts by state printed each minute. The first failed or cancelled
# check ends the wait, with its name, its link and the last lines of its log (a GitHub Actions job's; another check's
# link alone). The review gate's check (`review`) is not CI: it waits on Martin's approval, so it is printed and never
# ends the wait (WAIT_CI_IGNORE names such checks, space-separated). The wait stops itself at 25 minutes, naming what
# was still running: run it again, or look at why.
# Exit 0 when every check is green (passed or skipped); 1 at the first failed check; 2 on a usage error or a read of
# GitHub that failed; 3 when the pull request conflicts with its base; 4 when 25 minutes passed with checks still running.
# WAIT_CI_INTERVAL (seconds between reads, 30) and WAIT_CI_MINUTES (25) are for the tests.
set -euo pipefail
pr=${1:?usage: wait-ci.sh <pr> [key]}
[[ $pr =~ ^[0-9]+$ ]] || { echo "usage: wait-ci.sh <pr> [key]" >&2; exit 2; }
. "$(dirname "$0")/repo.sh"
for_key "${2:-}"
here=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [[ -z ${2:-} && -n $here && $(cd "$here/.." && pwd) != "$root" ]]; then
  echo "wait-ci.sh: in another repository's checkout; give the work item's key: wait-ci.sh $pr <key>" >&2; exit 2
fi
interval=${WAIT_CI_INTERVAL:-30} ignore=" ${WAIT_CI_IGNORE:-review} "
started=$(date +%s) ends=$(( $(date +%s) + ${WAIT_CI_MINUTES:-25} * 60 )) said=0
fields=name,state,bucket,link,workflow

# checks: every check on the head as JSON, [] while none is reported yet. gh exits 8 while any is pending.
checks() {
  local out status=0
  out=$(gh pr checks "$pr" -R "$repo" --json "$fields" 2>&1) || status=$?
  if (( status == 0 || status == 8 )) && jq -e 'type == "array"' <<<"$out" >/dev/null 2>&1; then echo "$out"
  elif grep -q 'no checks reported' <<<"$out"; then echo '[]'
  else echo "wait-ci: could not read the checks of #$pr: $out" >&2; return 2; fi
}

# tail_log <link>: the last lines of a GitHub Actions job's log, or the link alone.
tail_log() {
  if [[ $1 =~ /actions/runs/([0-9]+)/job/([0-9]+) ]]; then
    gh run view "${BASH_REMATCH[1]}" -R "$repo" --job "${BASH_REMATCH[2]}" --log-failed 2>/dev/null | tail -n "${WAIT_CI_LOG_LINES:-40}" ||
      echo "(its log could not be read yet: $1)"
  else
    echo "(not a GitHub Actions job: $1)"
  fi
}

while :; do
  IFS=$'\t' read -r state mergeable head < <(gh pr view "$pr" -R "$repo" --json state,mergeable,headRefOid \
    -q '[.state, .mergeable, .headRefOid] | @tsv') || { echo "wait-ci: could not read #$pr" >&2; exit 2; }
  if [[ $state == OPEN && $mergeable == CONFLICTING ]]; then
    echo "wait-ci: #$pr conflicts with its base: merge the base into the branch and push; no CI round is worth waiting for until then"
    exit 3
  fi
  all=$(checks) || exit 2
  # The checks that count, and the ones that are not CI's.
  counted=$(jq --arg ignore "$ignore" '[.[] | select(.name as $n | $ignore | contains(" \($n) ") | not)]' <<<"$all")
  now=$(date +%s)
  if (( now - said >= 60 )); then
    counts=$(jq -r 'group_by(.bucket) | map("\(.[0].bucket) \(length)") | join(", ")' <<<"$counted")
    aside=$(jq -r --arg ignore "$ignore" '[.[] | select(.name as $n | $ignore | contains(" \($n) ")) | "\(.name) \(.state)"]
      | join(", ")' <<<"$all")
    echo "wait-ci: #$pr ${head:0:8} at $(( (now - started) / 60 ))m: ${counts:-no checks yet}${aside:+ (not CI: $aside)}"
    said=$now
  fi
  failed=$(jq -r '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | first // empty
    | [.name, .state, .link] | @tsv' <<<"$counted")
  if [[ -n $failed ]]; then
    IFS=$'\t' read -r name check_state link <<<"$failed"
    echo "wait-ci: $name $check_state on ${head:0:8}: $link"
    tail_log "$link"
    exit 1
  fi
  if jq -e 'length > 0 and all(.[]; .bucket == "pass" or .bucket == "skipping")' <<<"$counted" >/dev/null; then
    echo "wait-ci: every check on ${head:0:8} is green ($(jq length <<<"$counted"))"
    exit 0
  fi
  if (( now >= ends )); then
    running=$(jq -r '[.[] | select(.bucket == "pending") | .name] | join(", ")' <<<"$counted")
    echo "wait-ci: still running after $(( (now - started) / 60 )) minutes: ${running:-no check reported yet}"
    exit 4
  fi
  sleep "$interval"
done
