#!/usr/bin/env bash
# Stop or start the scratch cluster's line, as Martin's own commands do: the factory copy's `make stop-the-line`,
# `make start-the-line` and `make new-work OFF=1`, in work/factory (copies.sh's `line`), which append the events through
# the code the real ones go through. Only the scratch store, as level.sh. ./stop.sh stopped|running
#   stopped  the line is stopped: the GitHub worker queues no move and no workflow pin of Dependabot's while it is. A
#            line never started is stopped already, to every worker: nothing is appended there.
#   running  the line runs, with new work off, so it takes no ticket and starts no step: what a run whose pull requests
#            the worker queues needs. A store restore, or `make new-work ON=1` in work/factory, puts new work back on.
# It reads the store first and runs nothing the store already says; then reads it again, and prints the line as it
# stands, `stopped` or `running`, alone on standard output. It exits 1, saying how the line stands, when the store
# does not read as asked afterwards: the caller must not go on as if it did.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:?stopped or running}" in
  stopped | running) want=$1 ;;
  *) echo "stop.sh: $1 is neither stopped nor running" >&2; exit 2 ;;
esac
# The line as the store has it, `running`, `stopped` or `never` (no start yet), and whether new work is on: read only.
stands() {
  kubectl --context k3d-software-factory-scratch -n factory exec -i postgres-0 -c postgres -- \
    psql -U factory -d factory -v ON_ERROR_STOP=1 -At <<'SQL'
select coalesce((select case type when 'line.started' then 'running' else 'stopped' end
                 from events where type in ('line.started', 'line.stopped') order by seq desc limit 1), 'never')
  || ' new-work=' ||
       coalesce((select case when coalesce((payload->>'newWork')::boolean, true) then 'on' else 'off' end
                 from events where type = 'controls.changed' order by seq desc limit 1), 'on');
SQL
}
# Whether the store reads as asked: stopped, or never started, which every worker takes as stopped; or running with
# new work off.
as_asked() { # <how it stands>
  case "$want $1" in
    "stopped stopped "* | "stopped never "*) return 0 ;;
    "running running new-work=off") return 0 ;;
    *) return 1 ;;
  esac
}
now=$(stands) || { echo "stop.sh: the scratch store could not be read" >&2; exit 1; }
if ! as_asked "$now"; then
  # The copy's own commands, their words to standard error: standard output is the one word a caller reads.
  if [ "$want" = stopped ]; then
    "$HERE/copies.sh" line stop >&2 || echo "stop.sh: make stop-the-line failed in work/factory" >&2
  else
    # New work off before the start, so the line that starts takes nothing.
    case "$now" in *new-work=on) "$HERE/copies.sh" line new-work-off >&2 || echo "stop.sh: make new-work OFF=1 failed in work/factory" >&2 ;; esac
    case "$now" in running\ *) ;; *) "$HERE/copies.sh" line start >&2 || echo "stop.sh: make start-the-line failed in work/factory" >&2 ;; esac
  fi
  now=$(stands) || { echo "stop.sh: the scratch store could not be read after the change" >&2; exit 1; }
fi
if as_asked "$now"; then
  echo "$want"
else
  hint=$([ "$want" = stopped ] && echo "make stop-the-line" || echo "make new-work OFF=1 and make start-the-line")
  echo "stop.sh: the scratch line is not $want (it stands: $now): $hint in work/factory, by hand, says why" >&2
  exit 1
fi
