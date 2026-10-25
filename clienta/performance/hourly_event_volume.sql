-- title: Hourly event volume
-- severity: warning
-- category: Events
-- description: Events per hour (event_time parsed from text); a drop means events stopped arriving.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    toStartOfHour(parseDateTimeBestEffortOrNull(event_time)) AS hour,
    count() AS events
FROM default.events
GROUP BY hour
ORDER BY hour
