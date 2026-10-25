-- title: Event times are not in the future
-- category: Events
-- description: Events timestamped more than 5 minutes ahead point to a clock or timezone problem upstream.
-- table: default.events
-- severity: warning
SELECT event_id, event_time
FROM default.events
WHERE parseDateTimeBestEffortOrNull(event_time) > now() + INTERVAL 5 MINUTE
