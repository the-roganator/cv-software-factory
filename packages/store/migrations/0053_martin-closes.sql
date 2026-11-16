-- Martin closes a work item from the console as he does from his command line: `work-item.closed` as a discard, with
-- his reason or none, whether the line has taken it or not, and the line closes its pull request and issue whatever
-- it takes (`admin/close.ts`). The admin service's role appends a close only as that discard: never as verified, rolled
-- back or any other end the factory's own work reaches, nor as an attack's, which stays the harness's.
create or replace function closes_as_martin(type text, payload jsonb) returns boolean language sql immutable parallel safe as $$
  select type = 'work-item.closed' and payload->>'outcome' = 'discarded'
$$;

-- The admin service's insert policy, rewritten whole: Postgres ORs permissive policies, so a second beside it would let
-- through what this one does.
alter policy events_admin_commands on events
  with check (admin_event(type) or opens_improvement(type, payload) or opens_attack(type, payload)
              or closes_as_martin(type, payload));
