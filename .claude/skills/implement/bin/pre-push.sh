#!/usr/bin/env bash
# Says what else would force another CI round, before a push to a pull request's branch: pre-push.sh <pr> [key]
# The key names the repository, as in repo.sh; without one, this one's, and it refuses to run in another repository's
# checkout. A push starts every check again, so whatever else needs a push goes in the same one:
#   - a conflict with the base, which needs a merge of the base;
#   - review threads not resolved, each with its path and the first line of its first comment;
#   - a check failed on the current head, each with its link. The review gate's `review` is set aside, as wait-ci.sh
#     sets it aside: it fails while it waits for Martin's approval, which no push mends.
# It informs and never blocks: exit 0 whatever it finds, 2 on a usage error or a read of GitHub that failed. The last
# line says how many things it found, or that there is nothing.
set -euo pipefail
pr=${1:?usage: pre-push.sh <pr> [key]}
[[ $pr =~ ^[0-9]+$ ]] || { echo "usage: pre-push.sh <pr> [key]" >&2; exit 2; }
. "$(dirname "$0")/repo.sh"
for_key "${2:-}"
here=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [[ -z ${2:-} && -n $here && $(cd "$here/.." && pwd) != "$root" ]]; then
  echo "pre-push.sh: in another repository's checkout; give the work item's key: pre-push.sh $pr <key>" >&2; exit 2
fi
ignore=" ${WAIT_CI_IGNORE:-review} " found=0

IFS=$'\t' read -r state mergeable head base < <(gh pr view "$pr" -R "$repo" --json state,mergeable,headRefOid,baseRefName \
  -q '[.state, .mergeable, .headRefOid, .baseRefName] | @tsv') || { echo "pre-push: could not read #$pr" >&2; exit 2; }
echo "pre-push: #$pr $state, head ${head:0:8}, base $base"
case $state/$mergeable in
  OPEN/CONFLICTING) echo "conflict: #$pr conflicts with $base: merge $base into the branch in the same push"; found=$((found + 1)) ;;
  OPEN/UNKNOWN) echo "conflict: GitHub has not worked out yet whether #$pr merges cleanly; run this again in a minute" ;;
esac

# Every review thread, a page of 100 at a time.
nodes='[]' cursor=''
while :; do
  page=$(gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" ${cursor:+-f cursor="$cursor"} -f query='
    query($owner:String!, $name:String!, $n:Int!, $cursor:String) { repository(owner:$owner, name:$name) {
      pullRequest(number:$n) { reviewThreads(first:100, after:$cursor) { pageInfo { hasNextPage endCursor }
        nodes { isResolved path line comments(first:1) { nodes { author { login } body } } } } } } }') &&
    nodes=$(jq -c --argjson so_far "$nodes" '$so_far + .data.repository.pullRequest.reviewThreads.nodes' <<<"$page") ||
    { echo "pre-push: could not read the review threads of #$pr" >&2; exit 2; }
  [[ $(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage // false' <<<"$page") == true ]] || break
  cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$page")
done
threads=$(jq -r '[.[] | select(.isResolved | not)
  | "  \(.path):\(.line // "-") (\(.comments.nodes[0].author.login // "?")) \(.comments.nodes[0].body | split("\n")[0] | .[0:160])"]
  | "\(length)\n\(join("\n"))"' <<<"$nodes")
count=$(head -1 <<<"$threads")
if (( count > 0 )); then
  echo "threads: $count unresolved: answer each in the same push, and resolve it after"
  tail -n +2 <<<"$threads"
  found=$((found + count))
fi

status=0
checks=$(gh pr checks "$pr" -R "$repo" --json name,state,bucket,link 2>&1) || status=$?
if (( status == 0 || status == 8 )) && jq -e 'type == "array"' <<<"$checks" >/dev/null 2>&1; then
  failed=$(jq -r --arg ignore "$ignore" '[.[] | select(.name as $n | $ignore | contains(" \($n) ") | not)
    | select(.bucket == "fail" or .bucket == "cancel") | "  \(.name) \(.state) \(.link)"] | join("\n")' <<<"$checks")
  if [[ -n $failed ]]; then
    n=$(grep -c . <<<"$failed")
    echo "checks: $n failed on ${head:0:8}: fix each in the same push"
    echo "$failed"
    found=$((found + n))
  fi
elif ! grep -q 'no checks reported' <<<"$checks"; then
  echo "pre-push: could not read the checks of #$pr: $checks" >&2; exit 2
fi

if (( found )); then echo "pre-push: $found thing(s) to put in the same push"
else echo "pre-push: nothing else would need another round"; fi
