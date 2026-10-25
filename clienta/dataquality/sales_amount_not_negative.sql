-- title: Sale amounts are not negative
-- category: Sales
-- description: Refunds are not recorded in this table, so amounts must be zero or more.
-- table: default.sales
-- severity: critical
SELECT * FROM default.sales WHERE amount < 0
