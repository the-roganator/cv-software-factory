-- The dependency sense sends the app's moves to triage (milestone 7, task 35): each of the app's moves in the lane
-- `line` with a target, as a `dependency` signal, which triage makes a ticket of. Its role gains the inbox's insert, of
-- its own sense's signals alone, and nothing more: it reads no row of the inbox, so a send it cannot tell went is sent
-- again under the same id, and the inbox keeps the first (`on conflict do nothing`, as every sense's send).
grant insert (id, sense, fingerprint, signal) on inbox to factory_patching;
create policy inbox_patching_sends on inbox for insert to factory_patching with check (sense = 'dependency');
