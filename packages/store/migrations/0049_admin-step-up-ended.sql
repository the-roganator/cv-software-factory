-- Martin ending the passkey given again before its five minutes are up is recorded as `admin.step-up-ended`, as giving
-- it is: one of his commands, so only his roles may append it. Nothing acts on it, but the audit log says he did it,
-- so no worker may say it for him.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'admin.step-up-ended',
                  'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed', 'controls.changed', 'alerts.switched', 'flag.staged',
                  'improvement.requested', 'attack.launched')
$$;
