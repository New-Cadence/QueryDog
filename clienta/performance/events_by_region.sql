-- title: Events by region
-- severity: info
-- category: Events
-- description: Event count per region with the share still open or pending.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    region,
    count() AS events,
    countIf(status IN ('open', 'pending')) AS unresolved,
    round(100 * unresolved / events, 1) AS unresolved_pct
FROM default.events
GROUP BY region
ORDER BY events DESC
