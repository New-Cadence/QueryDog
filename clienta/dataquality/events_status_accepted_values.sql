-- title: Event statuses are known statuses
-- category: Events
-- description: Status must be open, closed or pending.
-- table: default.events
-- severity: warning
SELECT * FROM default.events WHERE status NOT IN ('open', 'closed', 'pending')
