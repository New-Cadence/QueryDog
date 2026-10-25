-- title: Revenue by currency
-- severity: info
-- category: Revenue
-- description: Gross and net revenue (after discount) per currency, with sale counts and average sale value.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    currency,
    count() AS sales,
    round(sum(amount), 2) AS gross_revenue,
    round(sum(amount * (1 - coalesce(discount, 0))), 2) AS net_revenue,
    round(avg(amount), 2) AS avg_sale_value
FROM default.sales
GROUP BY currency
ORDER BY gross_revenue DESC
