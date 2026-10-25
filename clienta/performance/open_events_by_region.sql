-- title: Open and pending events by region
-- severity: warning
-- category: Events
-- description: Events still open or pending per region, with the oldest one; a growing backlog needs attention.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    region,
    count() AS unresolved,
    min(parseDateTimeBestEffortOrNull(event_time)) AS oldest
FROM default.events
WHERE status IN ('open', 'pending')
GROUP BY region
ORDER BY unresolved DESC
