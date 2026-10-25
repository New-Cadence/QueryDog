-- title: Sale currencies are supported
-- category: Sales
-- description: Only USD, EUR and GBP are priced; anything else is missing from revenue reports.
-- table: default.sales
-- severity: warning
SELECT * FROM default.sales WHERE currency NOT IN ('USD', 'EUR', 'GBP')
