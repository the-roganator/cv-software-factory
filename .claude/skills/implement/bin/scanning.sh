# Sourced by verify.sh: what code scanning says of a pull request. The caller defines say and bad, as verify.sh does.
# code_scanning <repo> <pr> <state> <head>: shows each alert open on the pull request, and calls bad while any is, or
# while an open pull request's head has not been analysed in every category code scanning has analysed it in. The
# analyses are of the merge ref (refs/pull/<n>/merge), whose commit has the head as a parent; each category's latest
# must be of a merge of this head, so an alert list read before the analysis of the last push is never taken as clean.
# An alert open on a merged pull request's ref passes once it is fixed on main or dismissed: the alert's own state, as
# against its state on the pull request, which stays open after the merge.
code_scanning() {
  local repo=$1 pr=$2 state=$3 head=$4 alerts n severity rule where url now analyses category sha pending=()
  # Every page read as one list: --paginate prints each page's array apart.
  alerts=$(gh api "repos/$repo/code-scanning/alerts?pr=$pr&state=open&per_page=100" --paginate | jq -rs 'add // []
    | .[] | [.number, (.rule.security_severity_level // .rule.severity), .rule.id,
      "\(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)", .html_url] | @tsv')
  say scanning "$(grep -c . <<<"$alerts" || true) alert(s) open on the pull request"
  while IFS=$'\t' read -r n severity rule where url; do
    [[ -n $n ]] || continue
    now=open
    [[ $state != MERGED ]] || now=$(gh api "repos/$repo/code-scanning/alerts/$n" | jq -r .state)
    if [[ $now == open ]]; then bad alert "#$n $severity $rule at $where, open: fix it, or draft Martin its dismissal $url"
    else say alert "#$n $severity $rule at $where, $now on main since the merge"; fi
  done <<<"$alerts"
  if [[ $state == MERGED ]]; then
    say scanning "analysis of the head not checked: merged"
    return
  fi
  analyses=$(gh api "repos/$repo/code-scanning/analyses?ref=refs/pull/$pr/merge&per_page=100" | jq -r '
    group_by(.category) | map(max_by(.created_at)) | .[] | [.category, .commit_sha] | @tsv')
  if [[ -z $analyses ]]; then
    bad scanning "code scanning has not analysed the pull request yet: run verify.sh again once its codeql checks finish"
    return
  fi
  while IFS=$'\t' read -r category sha; do
    gh api "repos/$repo/commits/$sha" 2>/dev/null | jq -e --arg head "$head" 'any(.parents[]; .sha == $head)' >/dev/null ||
      pending+=("$category")
  done <<<"$analyses"
  if (( ${#pending[@]} )); then
    bad scanning "code scanning has not analysed ${head:0:8} yet (${pending[*]}): run verify.sh again once its codeql checks finish"
  else
    say scanning "analysed ${head:0:8} in $(wc -l <<<"$analyses" | tr -d ' ') categories"
  fi
}
