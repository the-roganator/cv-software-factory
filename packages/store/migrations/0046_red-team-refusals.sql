-- The red-team harness (`factory_redteam`, 0045) records the refusals its attacks meet where the mechanism has no role
-- of its own: what the GitHub worker's guard refused it, and GitHub refused the App's token, for the workflow attack;
-- the review check's refusal of the attack's pull request; and the egress attack's own record of each connection the
-- runners' NetworkPolicy refused. The line may relay all but the last for its own work. As `policy/refusals.ts` sets
-- out, which the grants test holds this to, mechanism by mechanism, and inserts each mechanism as every role.
--
-- The function the restrictive policy of 0040 reads, rewritten whole: the policy itself is unchanged.

create or replace function refusal_appenders(mechanism text) returns text[] language sql immutable parallel safe as $$
  select case mechanism
    when 'scope-fence' then array['factory_line']
    when 'github-guard' then array['factory_line', 'factory_redteam']
    when 'token-permission' then array['factory_line', 'factory_redteam']
    when 'review-gate' then array['factory_line', 'factory_redteam']
    when 'admission-control' then array['factory_line']
    when 'gateway' then array['factory_gateway']
    when 'typed-judgement' then array['factory_triage']
    when 'egress-policy' then array['factory_redteam']
    else array[]::text[]
  end
$$;
