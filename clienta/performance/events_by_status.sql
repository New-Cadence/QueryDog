-- title: Events by status
-- severity: info
-- category: Events
-- description: Event count and share for each status.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    status,
    count() AS events,
    round(100 * events / sum(events) OVER (), 1) AS pct
FROM default.events
GROUP BY status
ORDER BY events DESC
