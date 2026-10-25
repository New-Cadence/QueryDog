-- title: Events missing notes by region
-- severity: info
-- category: Events
-- description: Events with no user notes per region and status.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    region,
    status,
    countIf(user_notes IS NULL OR user_notes = '') AS missing_notes,
    count() AS events
FROM default.events
GROUP BY region, status
ORDER BY missing_notes DESC
