#!/usr/bin/env bash
# Checks a sub-agent's report against GitHub and git.
#   verify.sh <key> <pr>   pr-open: the pull request is open, from the worktree's branch at its pushed HEAD, with
#                          nothing uncommitted; an issue's says Closes (or Part of) #<n>; every file it changes that
#                          CODEOWNERS gives Martin has a line in the description's section on them (a heading naming
#                          CODEOWNERS), with words beside the path. Whether those words are a good reason is left to
#                          the reader. Once Copilot has reviewed, a comment on the pull request from us, posted after
#                          its review and beginning "Copilot's review summary:", answers the review's summary; until
#                          Copilot has reviewed, or the hour window.sh gives it has passed, the pull request is not
#                          ready. No code-scanning alert is open on it, and code scanning has analysed its head
#                          (scanning.sh): until it has, the pull request is not ready. Shows checks, threads and alerts.
#                          A pull request Martin has merged passes on what is left to check (its description, checks,
#                          threads, alerts still open on main and summary): its worktree and branch may be gone.
#                          Whether a branch is behind main is never checked: the merge queue tests it on main as it
#                          will be.
#                          A file renamed or moved is checked under both its paths. Every file is listed, up to the
#                          files API's 3000; past that the pull request fails, as some of its files go unchecked.
#   verify.sh <key>        skipped: nothing was left behind (no commit on the worktree since it was made, so one made
#                          from a stack's branch below counts from there), no branch pushed and no pull request opened.
# A key of 278-2 is issue 278's second pull request. A key that begins app- is a work item in the app's repository
# (repo.sh): its pull request, CODEOWNERS, branch and origin/main are the app's, and its worktree is still under this
# checkout's scratch/worktrees/; app-278 is this repository's issue 278, which its description names in full
# (Part of the-roganator/cv-software-factory#278). Exit 1 on any mismatch.
set -euo pipefail
. "$(dirname "$0")/window.sh"
. "$(dirname "$0")/scanning.sh"
pr=${2:-}
. "$(dirname "$0")/repo.sh"
for_key "${1:?usage: verify.sh <key> [pr]}"
fail=0
say() { printf '%-9s %s\n' "$1" "$2"; }
bad() { say "$1" "MISMATCH: $2"; fail=1; }

if [[ -z $pr ]]; then
  if [[ -d $wt ]]; then
    branch=$(git -C "$wt" branch --show-current)
    say worktree "$wt on $branch"
    ahead=$(own_commits "$wt")
    (( ahead == 0 )) || bad commits "$ahead commit(s) on $branch"
    [[ -z $(git -C "$wt" status --porcelain) ]] || bad worktree "uncommitted changes in $wt"
    if git -C "$checkout" ls-remote -q --exit-code --heads origin "$branch" >/dev/null; then bad branch "$branch was pushed"; fi
    open=$(gh pr list -R "$repo" --head "$branch" --state all --json number -q '[.[].number] | join(" ")')
    [[ -z $open ]] || bad pr "pull request(s) from $branch: $open"
  else
    say worktree "none"
  fi
  exit $fail
fi

IFS=$'\t' read -r state branch head opened changed < <(gh pr view "$pr" -R "$repo" \
  --json state,headRefName,headRefOid,createdAt,changedFiles \
  -q '[.state, .headRefName, .headRefOid, (.createdAt | fromdateiso8601), .changedFiles] | @tsv')
body=$(gh pr view "$pr" -R "$repo" --json body -q .body)
say pr "#$pr $state $branch ${head:0:8}"
[[ $state == OPEN || $state == MERGED ]] || bad state "pull request is $state"
if [[ $key =~ ^(app-)?([0-9]+)(-[0-9]+)?$ ]]; then
  # An issue is always this repository's, so a pull request in the app's names it with its repository.
  issue=${BASH_REMATCH[2]} ref=''
  [[ -z ${BASH_REMATCH[1]} ]] || ref=$(repo_of "$root")
  grep -qiE "(closes|part of) $ref#$issue\b" <<<"$body" || bad body "no 'Closes $ref#$issue' or 'Part of $ref#$issue'"
fi

# Every changed file CODEOWNERS gives Martin, by its path or the path a rename moved it from, has a line in the
# description's section on them, with its reason beside it.
owners=$(git -C "$checkout" show origin/main:.github/CODEOWNERS | sed 's/#.*//' | awk 'NF { print $1 }')
files=$(pr_files "$repo" "$pr")
listed=$(grep -c . <<<"$files" || true)
(( listed == changed )) || bad files "GitHub lists $listed of the $changed files it changes: the rest go unchecked"
owned=()
while IFS=$'\t' read -r path previous; do
  for file in "$path" ${previous:+"$previous"}; do
    while IFS= read -r pattern; do
      # As GitHub reads them: globs, a folder owns what is in it, and a pattern with no slash but a trailing one is
      # unanchored, matching at any depth. Unquoted on purpose: the patterns are globs.
      p=${pattern#/} p=${p//\*\*/*} p=${p%/}
      at=''
      [[ $pattern == /* || $p == */* ]] || at='*/'
      # shellcheck disable=SC2053
      if [[ $file == $p || $file == $p/* || $file == $at$p || $file == $at$p/* ]]; then owned+=("$file"); break; fi
    done <<<"$owners"
  done
done <<<"$files"
say owned "${#owned[@]} file(s) CODEOWNERS gives Martin"
section=$(awk '/^#+ / { inside = /CODEOWNERS/; next } inside' <<<"$body")
if (( ${#owned[@]} )) && [[ -z $section ]]; then bad owned "no section on them: a heading naming CODEOWNERS"; fi
for file in ${owned[@]+"${owned[@]}"}; do
  line=$(grep -F "$file" <<<"$section" | head -1 || true)
  words=$(tr -d '`*' <<<"${line//"$file"/}" | tr -cs '[:alnum:]' '\n' | grep -c . || true)
  if [[ -z $line ]]; then bad owned "$file changes and the section does not name it"
  elif (( words < 3 )); then bad owned "$file is named with no reason beside it"; fi
done

if [[ $state == MERGED ]]; then
  say worktree "not checked: merged"
elif [[ -d $wt ]]; then
  wt_branch=$(git -C "$wt" branch --show-current)
  wt_head=$(git -C "$wt" rev-parse HEAD)
  [[ $wt_branch == "$branch" ]] || bad branch "worktree on $wt_branch, pull request from $branch"
  [[ $wt_head == "$head" ]] || bad head "worktree at ${wt_head:0:8}, pull request at ${head:0:8}"
  [[ -z $(git -C "$wt" status --porcelain) ]] || bad worktree "uncommitted changes in $wt"
else
  bad worktree "no worktree at $wt"
fi

say checks "$(gh pr checks "$pr" -R "$repo" --json state -q '[.[].state] | group_by(.) | map("\(.[0]) \(length)") | join(", ")')"
say threads "$(gh api graphql -F owner="${repo%/*}" -F name="${repo#*/}" -F n="$pr" -f query='
  query($owner:String!, $name:String!, $n:Int!) { repository(owner:$owner, name:$name) { pullRequest(number:$n) {
    reviewThreads(first:100) { nodes { isResolved } } } } }' \
  -q '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length') unresolved"

# An alert CodeQL found on the pull request is the worker's to fix, or to draft Martin a dismissal for: never ready while
# one is open.
code_scanning "$repo" "$pr" "$state" "$head"

# Copilot's summary can name findings no thread carries, so the worker answers it once in a comment. Whether the
# answer is right is the reader's to judge; that there is one, after the review, is checked here.
# Every page read as one list: --paginate runs a -q filter on each page alone.
reviewed=$(gh api "repos/$repo/pulls/$pr/reviews" --paginate | jq -rs 'add // []
  | [.[] | select(.user.login | startswith("copilot-pull-request-reviewer")) | .submitted_at] | last // empty')
if [[ -z $reviewed ]]; then
  if (( $(date +%s) - opened < copilot_window )); then
    bad summary "Copilot has not reviewed yet: run copilot.sh $pr $key again"
  else
    say summary "Copilot did not review within $(( copilot_window / 60 )) minutes of the opening"
  fi
else
  me=$(gh api user -q .login)
  answer=$(gh api "repos/$repo/issues/$pr/comments" --paginate | jq -rs --arg me "$me" --arg after "$reviewed" 'add // []
    | [.[] | select(.user.login == $me and .created_at > $after and (.body | startswith("Copilot'"'"'s review summary:")))
    | .html_url] | first // empty')
  if [[ -n $answer ]]; then say summary "answered $answer"
  else bad summary "no comment from $me after Copilot's review begins \"Copilot's review summary:\""; fi
fi
exit $fail
