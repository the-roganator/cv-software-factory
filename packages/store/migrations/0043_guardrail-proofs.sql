-- A guardrail's proof (`guardrail.proved`, milestone 7, task 21) is the proofs' alone. `make guardrails` takes each
-- proof a guardrail has outside an attack, from a clean checkout of main on the Mac, and records it as the proofs' role,
-- `factory_proofs`. The line's count of what pages Martin, and the Guardrails panel, trust a proof by that role, so no
-- other may append one: a worker that untrusted input had turned could otherwise record a guardrail as held when its
-- proof failed, or bury a failure under a pass.
--
-- The role appends that type and nothing else, and reads only what its proofs read: its own proofs, so an append may be
-- retried; Martin's stops and starts of the line, the gateway's refusals and the line's own record of a canary aborted
-- or rolled back, each from the role that alone may append it, for the stop-the-line and rollback proofs; and when each
-- work item was taken onto the line, to show a stopped line took none. Its password is in the Secret `postgres-proofs`,
-- which `make up` makes and the migrate Job sets. What it may do is set out in `policy/store-grants.ts`, and the grants
-- test fails unless the store is exactly that.

-- Roles belong to the whole server, not one database: it is made, or set as it must be, as in 0022.
do $$
begin
  begin
    create role factory_proofs login;
  exception when duplicate_object or unique_violation then null;
  end;
  if not (select rolcanlogin and rolinherit from pg_roles where rolname = 'factory_proofs') then
    alter role factory_proofs login inherit;
  end if;
end
$$;

grant usage on schema public to factory_proofs;
grant select, insert on events to factory_proofs;
-- The store's kind, which every append reads, and which the first append to an empty store decides.
grant select, insert on store to factory_proofs;
grant select (work_item, taken_at) on line to factory_proofs;

create policy events_proofs_read on events for select to factory_proofs
  using ((type = 'guardrail.proved' and appended_by = 'factory_proofs')
         or (type in ('line.stopped', 'line.started')
             and appended_by in ('factory_admin', 'factory_operator', 'factory_enrol'))
         or (type = 'action.refused' and payload->>'mechanism' = 'gateway' and appended_by = 'factory_gateway')
         or (type in ('release.aborted', 'release.rolled-back') and appended_by = 'factory_line'));
create policy events_proofs_append on events for insert to factory_proofs with check (type = 'guardrail.proved');

-- A restrictive policy, so it holds whatever the permissive ones let through: Postgres ORs permissive policies, and
-- ANDs each restrictive one with them. It applies to every role, Martin's included: his command line appends a proof
-- only as a sample (`make samples`), never as real work.
create policy events_proved_by_the_proofs on events as restrictive for insert
  with check (type <> 'guardrail.proved' or current_user = 'factory_proofs'
              or (current_user = 'factory_operator' and sample));
