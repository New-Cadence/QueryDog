-- title: Top 10 sales by amount
-- severity: info
-- category: Sales activity
-- description: The ten largest sales with their currency and discount.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT sale_id, sale_time, amount, currency, discount
FROM default.sales
ORDER BY amount DESC
LIMIT 10
