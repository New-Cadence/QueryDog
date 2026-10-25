-- title: Latest 100 sales
-- severity: info
-- category: Sales activity
-- description: The most recent sales, for spot checks after a load.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT sale_id, sale_time, amount, currency, discount
FROM default.sales
ORDER BY sale_time DESC
LIMIT 100
