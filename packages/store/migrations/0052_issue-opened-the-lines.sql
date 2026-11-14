-- The record of a work item's issue (`issue.opened`) is the line's alone. Its public view is the event whole, and for a
-- vulnerable move it is the moment the package, its versions and its advisories become public: a worker that untrusted
-- input had turned could otherwise publish a withheld move, or a move it made up. `LINE_ONLY_TYPES` in the events
-- package, which the store's tests hold this to.
create or replace function line_only_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('canary.stepped', 'canary.measuring', 'release.promoted', 'release.rolled-back', 'release.aborted',
                  'release.errored', 'issue.opened')
$$;

-- The dependency signal a move's issue was written from, set with the issue in one update: the record of the issue,
-- on the pass that opened it or a later one, discloses what the issue named, never a newer scan's.
alter table line add column issue_signal bigint;
grant update (issue_signal) on line to factory_line;
