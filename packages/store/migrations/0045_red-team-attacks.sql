-- A red-team attack (milestone 7, task 22): Martin launches one of spec 5.3's five from the console, and the red-team
-- harness makes it and records how it ended.
--
-- His launch, `attack.launched`, is one of his commands, so only his roles may append it, and the harness acts on one
-- only when one of them did. The admin service appends it on a work item of kind `red-team` it opens with it, in one
-- transaction, numbered as triage numbers work items, so the attack's card is there from the moment it is launched.
-- Only his roles may open a work item of that kind, as with an improvement: no worker can make an attack's card appear,
-- in his name or its own. Every other kind of work item is still opened by the workers.
--
-- How an attack ended, `attack.finished`, is the harness's alone, by a restrictive policy: the admin service lets a new
-- launch through once the last has finished, and the line and the Guardrails panel read an attack's outcome from it, so
-- a worker that untrusted input had turned must not be able to finish an attack for the harness, or as refused.
--
-- The harness's role, `factory_redteam`, is no member of the workers' role: it appends only an attack's end, the
-- refusals it relays, and its work item's close, each on a work item Martin launched an attack on; and it reads only
-- what it acts on and waits for: his launches and the work items they opened, the refusals of the two mechanisms whose
-- record another role keeps (triage's typed judgement, and admission control, which the line reads from the cluster),
-- each from a role that may speak for it, and its own events, so an append may be retried and a restart picks up where
-- it left off. Its password is in the Secret `postgres-redteam`, which `make up` makes and the migrate Job sets. What it
-- may do is set out in `policy/store-grants.ts`, and the grants test fails unless the store is exactly that.

-- Roles belong to the whole server, not one database: it is made, or set as it must be, as in 0022.
do $$
begin
  begin
    create role factory_redteam login;
  exception when duplicate_object or unique_violation then null;
  end;
  if not (select rolcanlogin and rolinherit from pg_roles where rolname = 'factory_redteam') then
    alter role factory_redteam login inherit;
  end if;
end
$$;

grant usage on schema public to factory_redteam;
grant select, insert on events to factory_redteam;
-- The store's kind, which every append reads, and which the first append to an empty store decides.
grant select, insert on store to factory_redteam;

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed', 'controls.changed', 'alerts.switched', 'flag.staged',
                  'improvement.requested', 'attack.launched')
$$;

-- The opening of an attack's work item: Martin's, though `work-item.opened` is no command of his alone.
create function opens_attack(type text, payload jsonb) returns boolean language sql immutable parallel safe as $$
  select type = 'work-item.opened' and payload->>'kind' = 'red-team'
$$;

-- Whether one of Martin's roles launched an attack on a work item. It reads the events as the role that asks, under
-- its own row security: the harness's role reads his launches. The table is named by its schema, and the search path
-- fixed with pg_temp last, so no role can stand a temporary table of its own called `events` in for the store's.
create function launched_by_martin(item text) returns boolean language sql stable parallel safe
  set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.events l
                 where l.work_item = item and l.type = 'attack.launched'
                   and l.appended_by in ('factory_admin', 'factory_operator', 'factory_enrol'))
$$;

-- Every worker's insert policy, and the admin service's, rewritten whole: Postgres ORs permissive policies, so a second
-- beside either would let through what the first does.
alter policy events_not_his on events
  with check (not admin_event(type) and not opens_improvement(type, payload) and not opens_attack(type, payload)
              and (not line_only_event(type) or current_user = 'factory_line'));
alter policy events_admin_commands on events
  with check (admin_event(type) or opens_improvement(type, payload) or opens_attack(type, payload));

create policy events_redteam_read on events for select to factory_redteam
  using (appended_by = 'factory_redteam'
         or (appended_by in ('factory_admin', 'factory_operator', 'factory_enrol')
             and (type = 'attack.launched' or opens_attack(type, payload)))
         or (type = 'action.refused' and payload->>'mechanism' in ('typed-judgement', 'admission-control')
             and appended_by = any (refusal_appenders(payload->>'mechanism'))));
-- Its close only as an attack ends: refused, not refused or unfinished, never as work the line did.
create policy events_redteam_append on events for insert to factory_redteam
  with check ((type in ('attack.finished', 'action.refused')
               or (type = 'work-item.closed' and payload->>'outcome' in ('refused', 'not-refused', 'unfinished')))
              and launched_by_martin(work_item));

-- A restrictive policy, so it holds whatever the permissive ones let through: Postgres ORs permissive policies, and
-- ANDs each restrictive one with them. It applies to every role, Martin's included: his command line appends an
-- attack's end only as a sample (`make samples`), never as real work.
create policy events_finished_by_the_harness on events as restrictive for insert
  with check (type <> 'attack.finished' or current_user = 'factory_redteam'
              or (current_user = 'factory_operator' and sample));
