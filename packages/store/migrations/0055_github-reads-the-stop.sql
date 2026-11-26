-- The GitHub worker reads whether the line is stopped, beside the autonomy level (0054): while Martin has the line
-- stopped, or has not yet started it, the worker adds no move to the merge queue, as at Supervised. It reads the stop
-- as the line does (`lineState`), the latest `line.started` or `line.stopped` of Martin's roles.
--
-- The same permissive policy, rewritten whole, with those two types beside his controls: `factory_github` in
-- `policy/store-grants.ts`, which the grants test holds it to. The columns it may read are as 0054 left them.

alter policy events_github_read on events
  using (type in ('controls.changed', 'line.started', 'line.stopped')
         and (appended_by is null or appended_by in ('factory_admin', 'factory_operator', 'factory_enrol')));
