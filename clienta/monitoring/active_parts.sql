-- title: Partitions with too many active parts
-- description: Counts active parts per partition across user tables and surfaces partitions with more than 150 parts. High part counts slow down merges, queries, and inserts.
-- severity: warning
-- category: Parts & merges
SELECT
    hostname() AS host,
    database,
    table,
    partition,
    count() AS active_parts,
    multiIf(count() > 300, 'CRIT', count() > 150, 'WARN', 'OK') AS severity
FROM system.parts
WHERE active = 1
  AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
GROUP BY host, database, table, partition
HAVING active_parts > 150
ORDER BY active_parts DESC
LIMIT 50
