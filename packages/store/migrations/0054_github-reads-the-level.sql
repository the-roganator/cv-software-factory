-- The GitHub worker reads the autonomy level, and nothing else (ADR 0014's levels, `ENQUEUES` in policy/line.ts): it
-- adds a move to the merge queue only at a level that queues the move's rule, as the line does its own, so one level
-- means the same everywhere. It reads the level as the line does, the latest `controls.changed` of Martin's roles.
--
-- Its role, `factory_github`, is no member of the workers' role, and appends nothing: the pod holds the App's key and
-- reaches the internet, so it may read only Martin's controls, and only the columns the read needs. No other table.
-- Its password is in the Secret `postgres-github`, which `make up` makes and the migrate
-- Job sets. What it may do is set out in `policy/store-grants.ts`, and the grants test fails unless the store is
-- exactly that.

-- Roles belong to the whole server, not one database: it is made, or set as it must be, as in 0022.
do $$
begin
  begin
    create role factory_github login;
  exception when duplicate_object or unique_violation then null;
  end;
  if not (select rolcanlogin and rolinherit from pg_roles where rolname = 'factory_github') then
    alter role factory_github login inherit;
  end if;
end
$$;

grant usage on schema public to factory_github;
grant select (seq, type, version, payload, appended_by) on events to factory_github;

-- Martin's controls as the factory heeds them (`fromMartin`): those his roles appended, or stored before the store
-- recorded who appended each.
create policy events_github_read on events for select to factory_github
  using (type = 'controls.changed'
         and (appended_by is null or appended_by in ('factory_admin', 'factory_operator', 'factory_enrol')));
