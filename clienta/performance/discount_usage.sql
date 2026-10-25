-- title: Discount usage by currency
-- severity: info
-- category: Revenue
-- description: Share of sales with a discount and the revenue given away, per currency.
-- warn_duration_ms: 500
-- fail_duration_ms: 2000
SELECT
    currency,
    count() AS sales,
    countIf(discount IS NOT NULL) AS discounted_sales,
    round(100 * discounted_sales / sales, 1) AS discounted_pct,
    round(sum(amount * coalesce(discount, 0)), 2) AS discount_value
FROM default.sales
GROUP BY currency
ORDER BY discount_value DESC
