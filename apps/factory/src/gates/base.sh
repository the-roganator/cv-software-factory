#!/usr/bin/env bash
# The commit the app's gates compare a change with (app-gates.yml): the one it would merge into now.
#
# On a pull request, the checkout of the change is its merge commit, which GitHub makes on the base branch's head as it
# is when the run's event happens, so its first parent is that head. The event's `pull_request.base.sha` is not: GitHub
# leaves it at the base's head when the pull request opened, or last moved, and once main has moved past it, main's own
# changes would count as the pull request's. In the merge queue, the group's `base_sha` is the commit its entry is made
# on: main with the entries ahead of it.
#
# Usage: base.sh <change checkout>, fetched two deep so the merge commit's parents are there, with GITHUB_EVENT_NAME, on a
# pull request PR_HEAD_SHA, its head, which must be the merge commit's second parent, and in the merge queue
# MERGE_GROUP_BASE_SHA. It prints the commit, and fails rather than guess one. A re-run keeps its event's merge commit,
# and so its base.
set -euo pipefail

change=${1:?usage: base.sh <change checkout>}

case "${GITHUB_EVENT_NAME:-}" in
  pull_request)
    # The commit and its parents: a merge commit has two, the base first.
    read -r -a commits <<< "$(git -C "$change" rev-list --parents -n 1 HEAD)"
    if [ "${#commits[@]}" -ne 3 ]; then
      echo "::error::The change's checkout (${commits[0]:-none}) is not a pull request's merge commit, so it names no base." >&2
      exit 1
    fi
    if [ "${commits[2]}" != "${PR_HEAD_SHA:-}" ]; then
      echo "::error::The change's checkout (${commits[0]}) merges ${commits[2]}, not the pull request's head (${PR_HEAD_SHA:-none})." >&2
      exit 1
    fi
    echo "${commits[1]}"
    ;;
  merge_group)
    if ! [[ "${MERGE_GROUP_BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
      echo "::error::The merge group names no base commit." >&2
      exit 1
    fi
    echo "$MERGE_GROUP_BASE_SHA"
    ;;
  *)
    echo "::error::The app's gates have a base only on pull_request and merge_group, not ${GITHUB_EVENT_NAME:-no event}." >&2
    exit 1
    ;;
esac
