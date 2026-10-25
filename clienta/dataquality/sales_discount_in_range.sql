-- title: Sale discounts are between 0 and 1
-- category: Sales
-- description: Discount is a fraction of the amount; values outside 0-1 would make net revenue wrong. Null means no discount.
-- table: default.sales
-- severity: warning
SELECT * FROM default.sales WHERE discount < 0 OR discount > 1
