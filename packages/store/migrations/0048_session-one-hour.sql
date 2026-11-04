-- A session lasts an hour from signing in (SESSION in policy/access.ts), however busy, with no idle timeout; the store
-- still sets the end from its own clock. Sessions already kept keep the end they were given: the check only widens.

alter table sessions alter column expires_at set default now() + interval '60 minutes';
alter table sessions drop constraint sessions_lasts;
alter table sessions add constraint sessions_lasts
  check (expires_at > signed_in_at and expires_at <= signed_in_at + interval '60 minutes');
