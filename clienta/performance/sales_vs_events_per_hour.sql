-- title: Sales and events per hour
-- severity: info
-- category: Cross-table
-- description: Joins hourly sales and event counts to compare the two feeds; also a join performance test.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    s.hour,
    s.sales,
    s.revenue,
    e.events
FROM
(
    SELECT toStartOfHour(sale_time) AS hour, count() AS sales, round(sum(amount), 2) AS revenue
    FROM default.sales
    GROUP BY hour
) AS s
FULL OUTER JOIN
(
    SELECT toStartOfHour(parseDateTimeBestEffortOrNull(event_time)) AS hour, count() AS events
    FROM default.events
    GROUP BY hour
) AS e USING (hour)
ORDER BY s.hour
