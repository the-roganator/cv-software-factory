#!/usr/bin/env bash
# Set the scratch cluster's auto-merge switch, as a controls.changed event of the operator's, keeping every other
# control. Only the scratch store, as level.sh. ./auto-merge.sh on|off
set -euo pipefail
case "${1:?on or off}" in on) to=true ;; off) to=false ;; *) echo "auto-merge.sh: $1 is neither on nor off" >&2; exit 2;; esac
kubectl --context k3d-software-factory-scratch -n factory exec -i postgres-0 -c postgres -- \
  psql -U factory -d factory -v ON_ERROR_STOP=1 -At -v to="$to" <<'SQL'
begin;
set local role factory_operator;
insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
select gen_random_uuid(), clock_timestamp(), null, type, version, actor,
       'Auto-merge set for a patching test',
       payload || jsonb_build_object('autoMerge', :'to'::boolean, 'change',
         jsonb_build_object('control', 'autoMerge', 'before', payload->'autoMerge', 'after', :'to'::boolean)),
       artifacts, public, sample
from events where type = 'controls.changed' order by seq desc limit 1
returning seq, appended_by, payload->>'autonomy', payload->>'autoMerge';
commit;
SQL
