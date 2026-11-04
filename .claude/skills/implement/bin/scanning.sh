# Sourced by verify.sh: what code scanning says of a pull request. The caller defines say and bad, as verify.sh does.
# code_scanning <repo> <pr> <state> <head>: calls bad while an open pull request's head has not been analysed in every
# category code scanning has analysed it in, then shows each alert open on the pull request, and calls bad while any
# is. The analyses are of the merge ref (refs/pull/<n>/merge), whose commit has the head as a parent; each category's
# latest must be of a merge of this head, and they are read before the alerts, so an alert list read before the
# analysis of the last push is never taken as clean. A category the workflow stops running stays named as not analysed:
# whoever reads it judges that. An alert open on a merged pull request's ref passes once it is fixed on main or
# dismissed: the alert's own state, as against its state on the pull request, which stays open after the merge.
code_scanning() {
  local repo=$1 pr=$2 state=$3 head=$4 alerts analyses n severity rule where url now category sha
  # Words, not arrays: macOS's bash 3.2 calls an empty array unbound under set -u.
  local pending='' on_head=' ' off_head=' '
  # Fields are split on the unit separator, which is not whitespace to read, so an empty one does not collapse.
  local sep=$'\x1f'
  if [[ $state != MERGED ]]; then
    analyses=$(gh api "repos/$repo/code-scanning/analyses?ref=refs/pull/$pr/merge&per_page=100" | jq -r '
      group_by(.category) | map(max_by(.created_at)) | .[] | [.category, .commit_sha] | join("\u001f")') ||
      { bad scanning "could not read code scanning's analyses of the pull request"; return; }
    if [[ -z $analyses ]]; then
      bad scanning "code scanning has not analysed the pull request yet: run verify.sh again once its codeql checks finish"
      return
    fi
    while IFS=$sep read -r category sha; do
      # Each commit is read once, however many categories were analysed on it.
      if [[ $on_head != *" $sha "* && $off_head != *" $sha "* ]]; then
        if gh api "repos/$repo/commits/$sha" 2>/dev/null | jq -e --arg head "$head" 'any(.parents[]; .sha == $head)' >/dev/null
        then on_head+="$sha "; else off_head+="$sha "; fi
      fi
      [[ $on_head == *" $sha "* ]] || pending+=" ${category:-no category}"
    done <<<"$analyses"
    if [[ -n $pending ]]; then
      bad scanning "code scanning has not analysed ${head:0:8} yet (${pending# }): run verify.sh again once its codeql checks finish"
      return
    fi
    say scanning "analysed ${head:0:8} in $(wc -l <<<"$analyses" | tr -d ' ') categories"
  fi
  # Every page read as one list: --paginate prints each page's array apart.
  alerts=$(gh api "repos/$repo/code-scanning/alerts?pr=$pr&state=open&per_page=100" --paginate | jq -rs 'add // []
    | .[] | [.number, (.rule.security_severity_level // .rule.severity // "unrated"), .rule.id,
      "\(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)", .html_url]
    | map(tostring) | join("\u001f")') || { bad scanning "could not read code scanning's alerts on the pull request"; return; }
  say scanning "$(grep -c . <<<"$alerts" || true) alert(s) open on the pull request"
  while IFS=$sep read -r n severity rule where url; do
    [[ -n $n ]] || continue
    now=open
    if [[ $state == MERGED ]]; then
      now=$(gh api "repos/$repo/code-scanning/alerts/$n" | jq -r .state) || now=unread
    fi
    if [[ $now == open ]]; then bad alert "#$n $severity $rule at $where, open: fix it, or draft Martin its dismissal $url"
    elif [[ $now == unread ]]; then bad alert "#$n $severity $rule at $where: could not read its state on main $url"
    else say alert "#$n $severity $rule at $where, $now on main since the merge"; fi
  done <<<"$alerts"
  [[ $state != MERGED ]] || say scanning "analysis of the head not checked: merged"
}
