-- title: Average sale value trend
-- severity: info
-- category: Revenue
-- description: Average, smallest and largest sale amount per hour.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    toStartOfHour(sale_time) AS hour,
    count() AS sales,
    round(avg(amount), 2) AS avg_amount,
    min(amount) AS min_amount,
    max(amount) AS max_amount
FROM default.sales
GROUP BY hour
ORDER BY hour
