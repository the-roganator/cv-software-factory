-- The proofs' role, `factory_proofs` (0043), read the gateway's refusals for the stop-the-line drill, which looked for
-- the gateway refusing a stopped line. That refusal is now proved from CI, and no proof reads a refusal, so the role
-- reads them no more: its own proofs, so an append may be retried; Martin's stops and starts of the line; and the
-- line's own record of a canary aborted or rolled back, each from the role that alone may append it. Its read of when
-- each work item was taken onto the line is as 0043 left it.
--
-- The same permissive policy, rewritten whole: `factory_proofs` in `policy/store-grants.ts`, which the grants test holds
-- it to.

alter policy events_proofs_read on events
  using ((type = 'guardrail.proved' and appended_by = 'factory_proofs')
         or (type in ('line.stopped', 'line.started')
             and appended_by in ('factory_admin', 'factory_operator', 'factory_enrol'))
         or (type in ('release.aborted', 'release.rolled-back') and appended_by = 'factory_line'));
