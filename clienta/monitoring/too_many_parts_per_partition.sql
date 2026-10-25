-- title: Partitions with more than 100 parts
-- description: Lists partitions with more than 100 active parts, including row and byte totals. Excessive parts per partition is a strong signal that inserts are too small or merges are falling behind.
-- severity: warning
-- category: Parts & merges
SELECT
    database,
    table,
    partition,
    count() AS active_parts,
    sum(rows) AS rows_total,
    formatReadableSize(sum(bytes_on_disk)) AS bytes_h
FROM system.parts
WHERE active = 1
GROUP BY database, table, partition
HAVING active_parts > 100
ORDER BY active_parts DESC
LIMIT 100
