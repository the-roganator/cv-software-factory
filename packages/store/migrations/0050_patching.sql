-- The dependency sense (milestone 7, task 31): `factory patching` reads both repositories' moves through the GitHub
-- worker, compares the images the cluster's pods run with the scan's list, and appends the day as one event,
-- `patching.read`, when it differs from the last.
--
-- The day is the sense's alone, by a restrictive policy: the Patching panel, Needs you, the alert rules and the pin
-- watch read what waits and what is due from it, so a worker that untrusted input had turned must not be able to write
-- a day in which nothing waits. Martin's command line appends one only as a sample (`make samples`).
--
-- Its role, `factory_patching`, is no member of the workers' role: it appends `patching.read` and nothing else, and
-- reads only its own events, the last of which it compares the day with. No other table. Its password is in the Secret
-- `postgres-patching`, which `make up` makes and the migrate Job sets. What it may do is set out in
-- `policy/store-grants.ts`, and the grants test fails unless the store is exactly that.

-- Roles belong to the whole server, not one database: it is made, or set as it must be, as in 0022.
do $$
begin
  begin
    create role factory_patching login;
  exception when duplicate_object or unique_violation then null;
  end;
  if not (select rolcanlogin and rolinherit from pg_roles where rolname = 'factory_patching') then
    alter role factory_patching login inherit;
  end if;
end
$$;

grant usage on schema public to factory_patching;
grant select, insert on events to factory_patching;
-- The store's kind, which every append reads, and which the first append to an empty store decides.
grant select, insert on store to factory_patching;

create policy events_patching_read on events for select to factory_patching
  using (appended_by = 'factory_patching');
create policy events_patching_append on events for insert to factory_patching
  with check (type = 'patching.read');

-- A restrictive policy, so it holds whatever the permissive ones let through: Postgres ORs permissive policies, and
-- ANDs each restrictive one with them. It applies to every role, Martin's included.
create policy events_read_by_the_sense on events as restrictive for insert
  with check (type <> 'patching.read' or current_user = 'factory_patching'
              or (current_user = 'factory_operator' and sample));

-- The sense's name joins the inbox's, so its signals to triage (task 35) are a sense's like any other. It sends none
-- yet, so its role has no grant on the inbox.
alter table inbox drop constraint inbox_sense_check;
alter table inbox add constraint inbox_sense_check
  check (sense in ('probe', 'crawler', 'metrics', 'logs', 'canary', 'report', 'planner', 'dependency'));
