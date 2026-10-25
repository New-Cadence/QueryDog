-- title: Busiest minutes for sales
-- severity: info
-- category: Sales activity
-- description: The ten minutes with the most sales and their revenue.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    toStartOfMinute(sale_time) AS minute,
    count() AS sales,
    round(sum(amount), 2) AS revenue
FROM default.sales
GROUP BY minute
ORDER BY sales DESC
LIMIT 10
