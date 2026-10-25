-- title: Sales arrived in the last day
-- category: Sales
-- description: New sales should arrive at least daily; no rows for 24 hours means the load has stopped.
-- table: default.sales
-- severity: warning
SELECT max(sale_time) AS latest, dateDiff('minute', latest, now()) AS age_minutes
FROM default.sales
HAVING age_minutes > 1440
