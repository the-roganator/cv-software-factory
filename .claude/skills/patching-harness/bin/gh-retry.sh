# shellcheck shell=bash
# A call of gh's that sets a run up, tried again when the fault is GitHub's or the network's (rulesets.sh sources this,
# and copies.sh through it): `gh_retry <gh's arguments>`.
#
# A pass is hours long and makes hundreds of these calls: a variable set, a ruleset off or on, a label, a pull request
# closed, a ref deleted. One answer of GitHub's in the 500s, or a connection that drops, is not the call's failure, so
# the call is made again: three tries in all, GH_RETRY_PAUSE seconds (5) after the first and twice that after the
# second, each failure said on standard error with what gh said. Anything else fails at once, as gh alone would: a 4xx
# is the call's own fault, and a second try would say the same.
#
# gh's standard output is the caller's, and its standard error is passed on whole. Its standard input is /dev/null:
# a call that reads one (a secret, a body from a pipe) cannot be made twice and is not made through this. A call
# GitHub took before it answered 5xx is made again, so only one that may be made twice comes here: a set, a PUT, a
# close or a delete, whose second answer is the first's or a 4xx.
GH_RETRIED='HTTP 5[0-9][0-9]|dial tcp|connection reset|connection refused|i/o timeout|TLS handshake timeout|unexpected EOF|EOF$|no such host|server misbehaving|context deadline exceeded|error connecting to'
gh_retry() {
  local try=1 tries=3 pause=${GH_RETRY_PAUSE:-5} status said why
  said=$(mktemp)
  while :; do
    status=0
    gh "$@" </dev/null 2>"$said" || status=$?
    cat "$said" >&2
    [[ $status -ne 0 && $try -lt $tries ]] || break
    why=$(grep -Eio -m1 -- "$GH_RETRIED" "$said" | head -1 || true)
    [[ -n $why ]] || break
    echo "gh ${*:1:2}: try $try of $tries failed on GitHub's side or the network's ($why): again in $((pause * try)) seconds" >&2
    sleep "$((pause * try))"
    try=$((try + 1))
  done
  if [[ $status -ne 0 && $try -gt 1 ]]; then echo "gh ${*:1:2}: failed $try times, and is not tried again" >&2; fi
  rm -f "$said"
  return "$status"
}
