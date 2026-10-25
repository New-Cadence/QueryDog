-- title: Sale times are not in the future
-- category: Sales
-- description: Sales timestamped more than 5 minutes ahead point to a clock or timezone problem upstream.
-- table: default.sales
-- severity: warning
SELECT sale_id, sale_time
FROM default.sales
WHERE sale_time > now() + INTERVAL 5 MINUTE
