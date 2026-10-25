-- title: Daily revenue
-- severity: info
-- category: Revenue
-- description: Revenue and sale count per day, newest first.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    toDate(sale_time) AS day,
    count() AS sales,
    round(sum(amount), 2) AS revenue
FROM default.sales
GROUP BY day
ORDER BY day DESC
