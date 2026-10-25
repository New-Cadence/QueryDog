-- title: Sale IDs are unique
-- category: Sales
-- description: Every sale has its own id; duplicates double-count revenue.
-- table: default.sales
-- severity: critical
SELECT sale_id, count() AS duplicate_rows
FROM default.sales
GROUP BY sale_id
HAVING duplicate_rows > 1
