#!/usr/bin/env bash
# Set the scratch cluster's autonomy level, as a controls.changed event of the operator's, keeping every other control.
# Only the scratch store: Martin allows writing it directly. ./level.sh supervised|guarded|lights-out
set -euo pipefail
to=${1:?supervised, guarded or lights-out}
case "$to" in supervised|guarded|lights-out) ;; *) echo "level.sh: $to is no level" >&2; exit 2;; esac
kubectl --context k3d-software-factory-scratch -n factory exec -i postgres-0 -c postgres -- \
  psql -U factory -d factory -v ON_ERROR_STOP=1 -At -v to="$to" <<'SQL'
begin;
set local role factory_operator;
insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
select gen_random_uuid(), clock_timestamp(), null, type, version, actor,
       'The autonomy level set for a patching test',
       payload || jsonb_build_object('autonomy', :'to', 'change',
         jsonb_build_object('control', 'autonomy', 'before', payload->>'autonomy', 'after', :'to')),
       artifacts, public, sample
from events where type = 'controls.changed' order by seq desc limit 1
returning seq, appended_by, payload->>'autonomy';
commit;
SQL
