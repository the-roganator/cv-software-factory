#!/usr/bin/env bash
# The few figures that say why platform.yml's cluster did not come up, on one line of at most 200 characters, for the
# step after `Make the cluster` to carry in its name. A hosted runner that dies after the cluster fails takes its log,
# its annotations and any artifact it had not yet uploaded with it; what reaches GitHub is each step's name, state and
# times, which the runner sends as each step starts. So the line goes out in a step's name, while the runner is alive.
#
#   platform-fault.sh <why> <measure>
#
# <why> is what stopped the cluster: `make <status>`, `watch`, or, said by the step after it, `timed out` (the step's own
# limit) or `cancelled`. <measure> is the job's measure directory: `memory` (Measure's memory in use, MiB, every five
# seconds), `make.log` (make's output) and `watch.log` (the watch's). The line:
#
#   <why> | mem <now>/<peak>M swap <used>M | disk <use> | oom <kills> | net ghcr <code> gh <code> dns <ok|no> |
#   docker <ok|no> | pod <the first not running: namespace/name status age> | <make's or the watch's last words>
#
# The figures first, so the last words are what 200 characters cut short.
# A code of 000 is a request that got no answer within five seconds. Every command that asks the system, the network,
# Docker or the cluster is bounded by `timeout -k`: SIGTERM at its limit, then SIGKILL two seconds later, as a command
# may catch SIGTERM and go on waiting (the docker CLI catches it to cancel its request), and `timeout` without `-k`
# waits with it. So it takes about a minute at most, however dead the runner's network, Docker or the cluster, short of
# a process the kernel holds in an uninterruptible wait, which no signal ends. KUBECTL is the kubectl command with its
# context.
set -uo pipefail

# <seconds> <command…>: the command, ended at its limit for certain.
bounded() { local limit=$1; shift; timeout -k 2 "$limit" "$@"; }

why=${1:?why}
measure=${2:?measure}
read -r -a kubectl <<<"${KUBECTL:-kubectl --context k3d-software-factory}"

# The last line of a log that is not blank, without its timestamps' noise.
last() { [ -r "$1" ] && grep -v '^[[:space:]]*$' "$1" | tail -1 | tr -s ' \t' ' '; }

case "$why" in
  watch) said=$(head -1 "$measure/watch.log" 2>/dev/null) ;;
  *) said=$(last "$measure/make.log") ;;
esac

memory=$(bounded 5 free -m 2>/dev/null)
now=$(awk '/^Mem:/ { print $3 }' <<<"$memory")
swap=$(awk '/^Swap:/ { print $3 }' <<<"$memory")
peak=$(sort -n "$measure/memory" 2>/dev/null | tail -1)
disk=$(bounded 5 df -P / 2>/dev/null | awk 'NR == 2 { print $5 }')
oom=$(bounded 5 sudo -n dmesg 2>/dev/null | grep -ciE 'out of memory|oom-kill') || true
probe() { bounded 6 curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }
ghcr=$(probe https://ghcr.io/v2/)
gh=$(probe https://github.com/)
dns=no
bounded 5 getent hosts ghcr.io >/dev/null 2>&1 && dns=ok
docker=no
bounded 10 docker info >/dev/null 2>&1 && docker=ok
pod=$(bounded 8 "${kubectl[@]}" --request-timeout=5s get pods -A --no-headers 2>/dev/null |
  awk 'NF >= 6 && $4 != "Running" && $4 != "Completed" { print $1 "/" $2, $4, $NF; exit }')

line="$why | mem ${now:-?}/${peak:-?}M swap ${swap:-?}M | disk ${disk:-?} | oom ${oom:-?} | net ghcr ${ghcr:-000} gh ${gh:-000} dns $dns | docker $docker | pod ${pod:-none} | ${said:-nothing said}"
# One line, no longer than a step's name is worth.
line=${line//$'\n'/ }
printf '%s\n' "${line:0:200}"
