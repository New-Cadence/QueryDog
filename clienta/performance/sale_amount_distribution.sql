-- title: Sale amount distribution
-- severity: info
-- category: Revenue
-- description: Percentiles of the sale amount, to spot skew and outliers.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    count() AS sales,
    round(quantile(0.5)(amount), 2) AS p50,
    round(quantile(0.9)(amount), 2) AS p90,
    round(quantile(0.99)(amount), 2) AS p99,
    max(amount) AS max_amount
FROM default.sales
