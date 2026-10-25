# Data quality assertions

Each `.sql` file here is a check. It returns the rows that break the rule, so it
passes when it returns nothing. Optional header lines set how it runs:

```sql
-- title: Orders have a customer
-- table: shop.orders
-- severity: critical        (critical | warning | info, default warning)
-- description: Every order belongs to a customer.
-- threshold: 0              (% of failing rows tolerated, needs `table`)
SELECT * FROM shop.orders WHERE customer_id IS NULL
```

With `-- table:` set, the failing share is measured against that table's row
count; without it, any returned row fails the check. Files are read-only in
Convoy: edit them here and redeploy. How often they run is set by the
`scheduler:` section of querydog.yml.
