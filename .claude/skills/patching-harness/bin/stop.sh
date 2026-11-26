#!/usr/bin/env bash
# Stop or start the scratch cluster's line, as a line.stopped or line.started event of the operator's, as Martin's Stop
# and Start append them. Only the scratch store, as level.sh. ./stop.sh stopped|running
#   stopped  the line is stopped: the GitHub worker queues no move and no workflow pin of Dependabot's while it is
#   running  the line runs, with new work off (a controls.changed, keeping every other control), so it takes no ticket
#            and starts no step: what a run whose pull requests the worker queues needs. A store restore, or
#            `make new-work ON=1` in work/factory, puts new work back on.
# It appends nothing the store already says, and prints the line as it stands: `stopped` or `running`.
set -euo pipefail
case "${1:?stopped or running}" in
  stopped) type=line.stopped ;;
  running) type=line.started ;;
  *) echo "stop.sh: $1 is neither stopped nor running" >&2; exit 2 ;;
esac
out=$(kubectl --context k3d-software-factory-scratch -n factory exec -i postgres-0 -c postgres -- \
  psql -U factory -d factory -v ON_ERROR_STOP=1 -At -v type="$type" <<'SQL'
begin;
set local role factory_operator;
-- New work off before a start, so the line that starts takes nothing.
insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
select gen_random_uuid(), clock_timestamp(), null, type, version, actor,
       'New work set off for a patching test',
       payload || jsonb_build_object('newWork', false, 'change',
         jsonb_build_object('control', 'new-work', 'before', payload->'newWork', 'after', false)),
       artifacts, public, sample
from (select * from events where type = 'controls.changed' order by seq desc limit 1) last
where :'type' = 'line.started' and coalesce((payload->>'newWork')::boolean, true);
-- The event, shaped as the last of its type, unless the line already stands so.
insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
select gen_random_uuid(), clock_timestamp(), null, type, version, actor,
       case when type = 'line.stopped' then 'The line stopped: a patching test' else 'The line started' end,
       jsonb_build_object('reason', 'a patching test'), artifacts, public, sample
from (select * from events where type = :'type' order by seq desc limit 1) last
where (select type from events where type in ('line.started', 'line.stopped') order by seq desc limit 1) <> :'type';
select 'line ' || type from events where type in ('line.started', 'line.stopped') order by seq desc limit 1;
commit;
SQL
)
case "$out" in
  *"line $type"*) echo "$1" ;;
  *)
    echo "stop.sh: the scratch store has no $type to shape one on (the line stands: ${out:-never started}): make ${1/stopped/stop}-the-line in work/factory, once" >&2
    exit 1
    ;;
esac
