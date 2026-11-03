-- Attack 1 (`report`, milestone 7 task 22): the red-team harness sends a report through the app's report route, as a
-- visitor does, and must then find triage's refusal of that very report, not another visitor's that arrived in the
-- same minute. It cannot compute the report's inbox id: that id is made from the Loki record the log watcher read
-- (`reportSignalId` in apps/factory/src/logs/reports.ts), from fields the harness never sees. So the harness marks its
-- report's text with a nonce of its own and reads back, through this function and nothing else, the id of the inbox
-- signal whose text carries that nonce. That id is the signal id triage keyed its events on, so the harness names it
-- as `attack.finished`'s `subject.report`, and the line checks triage's refusal is that report's (line/attacks.ts).
--
-- `factory_redteam` has no right to read the `inbox`, which holds visitors' reports. The function runs as its owner,
-- the role the migrations run as, so it does only what it says: it returns one id and never a report's words, matches
-- a `report` signal alone, and matches by a literal substring (`strpos`, not `like`, so no wildcard in the marker
-- widens it) that has the shape of the harness's own marker, `red-team-` and a UUID, so no other words can name a
-- report the harness did not send, nor ask whether any visitor's report holds them.
-- Should two reports carry the marker (a visitor who copied the harness's words), the first the inbox received is the
-- harness's own, which arrived before anyone could read it. Only `factory_redteam` may call it; `public` may not.
create function red_team_report_signal(marker text) returns uuid
language sql security definer set search_path = pg_catalog, public, pg_temp as $$
  select id from inbox
  where sense = 'report'
    and marker ~ '^red-team-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and strpos(signal -> 'report' ->> 'text', marker) > 0
  order by received_at, id
  limit 1
$$;

revoke all on function red_team_report_signal(text) from public;
grant execute on function red_team_report_signal(text) to factory_redteam;
