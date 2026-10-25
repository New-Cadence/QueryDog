-- title: Event times are valid timestamps
-- category: Events
-- description: event_time is stored as a String, so nothing stops bad values being inserted. Every value must parse as a date and time.
-- table: default.events
-- severity: critical
SELECT event_id, event_time
FROM default.events
WHERE parseDateTimeBestEffortOrNull(event_time) IS NULL
