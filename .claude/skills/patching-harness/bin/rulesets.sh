# shellcheck shell=bash
# A copy's branch rulesets, off for one push of Martin's to its main and on again after (copies.sh sources this).
#
# Every branch ruleset on the copy (github-settings.ts makes "main", which nobody bypasses, and "branches" for every
# branch outside the prefixes the factory writes, which Martin's login, this script's, is exempt from): off for a push
# to main, on again after. The tag ruleset ("tag main") is never touched: no push here names that tag.
#
# A copy whose rulesets are off is remembered until they are on again, and put back on any exit: a push that fails, a
# call of GitHub's that fails part way, a signal. Left off, the copy's main takes any push, and N10's push lands.
RULESETS_OFF=()
ruleset() { # <copy> active|disabled
  local id ids
  if [[ $2 == disabled ]]; then RULESETS_OFF+=("$1"); fi
  # Each failure is returned, not left to `set -e`, which a caller's `if` or `||` switches off: a ruleset not listed
  # or not changed is never taken as done.
  ids=$(gh api "repos/$1/rulesets" --jq '.[] | select(.target == "branch") | .id') || return 1
  for id in $ids; do
    gh api -X PUT "repos/$1/rulesets/$id" -f enforcement="$2" >/dev/null || return 1
  done
  if [[ $2 == active ]]; then
    local copy kept=()
    for copy in ${RULESETS_OFF[@]+"${RULESETS_OFF[@]}"}; do [[ $copy == "$1" ]] || kept+=("$copy"); done
    RULESETS_OFF=(${kept[@]+"${kept[@]}"})
  fi
}
# On any exit: each copy still off, on again, and said so; one that cannot be put back is named with what to run.
rulesets_back() {
  local status=$? copy
  trap - EXIT
  set +e
  for copy in ${RULESETS_OFF[@]+"${RULESETS_OFF[@]}"}; do
    if ruleset "$copy" active; then
      echo "copies.sh: $copy's branch rulesets are on again, after an exit with them off" >&2
    else
      echo "copies.sh: $copy's BRANCH RULESETS MAY BE OFF: ./copies.sh settings puts them back" >&2
    fi
  done
  exit "$status"
}
trap rulesets_back EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
