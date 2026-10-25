-- title: Event status by region
-- severity: info
-- category: Events
-- description: Open, pending and closed events per region side by side.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    region,
    countIf(status = 'open') AS open,
    countIf(status = 'pending') AS pending,
    countIf(status = 'closed') AS closed,
    count() AS total
FROM default.events
GROUP BY region
ORDER BY total DESC
