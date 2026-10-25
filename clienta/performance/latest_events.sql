-- title: Latest 100 events
-- severity: info
-- category: Events
-- description: The most recent events, for spot checks after a load.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT event_id, event_time, status, region, user_notes
FROM default.events
ORDER BY parseDateTimeBestEffortOrNull(event_time) DESC
LIMIT 100
