-- title: Detached parts present
-- description: Lists every detached part currently sitting in system.detached_parts along with its reason and disk. Detached parts indicate data that ClickHouse pulled out of active service and may need manual cleanup or reattachment.
-- severity: warning
-- category: Parts & merges
SELECT
    database,
    table,
    partition_id,
    name,
    reason,
    disk
FROM system.detached_parts
ORDER BY database, table, name
LIMIT 200
