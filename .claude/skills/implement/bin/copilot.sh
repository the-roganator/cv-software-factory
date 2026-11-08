#!/usr/bin/env bash
# Waits for Copilot's one review of a pull request, then lists the unresolved threads: copilot.sh <pr> [key]
# The key names the repository, as in repo.sh: an app- key's pull request is in the app's; without one, this one's,
# and it refuses to run in another repository's checkout, where a bare number would name the wrong pull request.
# Copilot may review up to an hour after the pull request opens (window.sh), longer than one command may run, so each
# run waits at most eight minutes. Exit 0 once Copilot has reviewed; 5 if it has not yet, so run it again; 4 if the hour
# is over without a review; 3 if Copilot was never asked (a Dependabot pull request, or one it is not assigned to), which
# the timeline says within a minute of opening, so there is nothing to wait for. The threads are listed either way, one block each: thread id, path:line, author, url, the
# first comment. A thread someone other than Copilot started is marked NOT COPILOT: it is theirs to resolve, not the
# worker's. Then Copilot's review summary, as written, with only its HTML tags taken out (by name, so `Result<T>`
# stays): it can name findings that have no thread, and its shape changes, so it is printed for the worker to read
# rather than parsed.
set -euo pipefail
. "$(dirname "$0")/window.sh"
pr=${1:?usage: copilot.sh <pr> [key]}
. "$(dirname "$0")/repo.sh"
for_key "${2:-}"
here=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
if [[ -z ${2:-} && -n $here && $(cd "$here/.." && pwd) != "$root" ]]; then
  echo "copilot.sh: in another repository's checkout; give the work item's key: copilot.sh $pr <key>" >&2; exit 2
fi
opened=$(gh pr view "$pr" -R "$repo" --json createdAt -q '.createdAt | fromdateiso8601')
window_ends=$(( opened + copilot_window )) run_ends=$(( $(date +%s) + 8 * 60 ))
# Every page of reviews, read as one list: --paginate runs a -q filter on each page alone.
reviews() { gh api "repos/$repo/pulls/$pr/reviews" --paginate | jq -s 'add // []
  | [.[] | select(.user.login | startswith("copilot-pull-request-reviewer"))]'; }
# Whether Copilot was asked at all: a review_requested event on the timeline, written as the pull request opens. Without
# one there is no review to wait for; a pull request younger than two minutes is given that long for the event to land.
asked() { gh api "repos/$repo/issues/$pr/timeline" --paginate | jq -s 'add // []
  | any(.[]; .event == "review_requested" and (.requested_reviewer.login // "" | startswith("Copilot")))'; }
status=0
until (( $(reviews | jq length) > 0 )); do
  if [[ $(asked) != true ]]; then
    if (( $(date +%s) < opened + 120 )); then sleep $(( opened + 120 - $(date +%s) )); continue; fi
    echo "copilot: no review was asked for, so none is coming"; status=3; break
  fi
  now=$(date +%s)
  if (( now >= window_ends )); then echo "copilot: no review within $(( copilot_window / 60 )) minutes of opening"; status=4; break; fi
  if (( now >= run_ends )); then echo "copilot: not reviewed yet; run copilot.sh $pr${2:+ $2} again"; status=5; break; fi
  sleep $(( run_ends - now < 30 ? run_ends - now : 30 ))
done
(( status )) || echo "copilot: reviewed"
gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" -f query='
  query($owner:String!, $name:String!, $n:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$n) {
    reviewThreads(first:100) { nodes { id isResolved path line comments(first:1) { nodes { author { login } url body } } } }
  } } }' -q '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)
    | (.comments.nodes[0].author.login) as $who
    | "\n\(.id)  \(.path):\(.line // "-")  (\($who))\(if ($who | startswith("copilot")) then "" else "  NOT COPILOT" end)\n\(.comments.nodes[0].url)\n\(.comments.nodes[0].body)"'
reviews | jq -r 'last | select(. != null)
    | "\n--- Copilot'"'"'s review summary (\(.submitted_at)), \(.html_url)\n\(.body)"' \
  | sed -E -e 's/<!--[^>]*-->//g' \
    -e 's#</?(picture|source|img|details|summary|sub|sup|br|p|div|span|b|strong|em|code|a)( [^>]*)?/?>##g' | cat -s
exit $status
