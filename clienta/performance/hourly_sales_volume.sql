-- title: Hourly sales volume
-- severity: warning
-- category: Sales activity
-- description: Sales per hour split by currency; a sudden drop means sales stopped arriving.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    toStartOfHour(sale_time) AS hour,
    countIf(currency = 'USD') AS usd,
    countIf(currency = 'EUR') AS eur,
    countIf(currency = 'GBP') AS gbp,
    count() AS total
FROM default.sales
GROUP BY hour
ORDER BY hour
