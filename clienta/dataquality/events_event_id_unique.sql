-- title: Event IDs are unique
-- category: Events
-- description: Every event has its own id; duplicates mean a double insert or a replayed batch.
-- table: default.events
-- severity: critical
SELECT event_id, count() AS duplicate_rows
FROM default.events
GROUP BY event_id
HAVING duplicate_rows > 1
