-- Martin closes a work item from the console as he does from his command line: `work-item.closed` as a discard, with
-- his reason or none, whether the line has taken it or not, and the line closes its pull request and issue whatever
-- it takes (`admin/close.ts`). The admin service's role appends a close only as that discard: never as verified, rolled
-- back or any other end the factory's own work reaches, and never on an attack's work item, which ends as its attack
-- does, recorded by the harness.
create function opened_as_attack(item text) returns boolean language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.events o
                 where o.work_item = item and o.type = 'work-item.opened' and o.payload->>'kind' = 'red-team')
$$;

create function closes_as_martin(type text, payload jsonb, item text) returns boolean language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as $$
  select type = 'work-item.closed' and payload->>'outcome' = 'discarded' and not opened_as_attack(item)
$$;

-- The admin service's insert policy, rewritten whole: Postgres ORs permissive policies, so a second beside it would let
-- through what this one does.
alter policy events_admin_commands on events
  with check (admin_event(type) or opens_improvement(type, payload) or opens_attack(type, payload)
              or closes_as_martin(type, payload, work_item));
