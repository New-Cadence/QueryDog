-- title: Tables growing quickly (last 24 hours)
-- description: Compares each table's current on-disk size against bytes added in the last 24 hours and lists tables that grew by more than 10 GB. Useful for catching unexpected ingestion spikes.
-- severity: info
-- category: Storage
WITH parts AS (
    SELECT
        database,
        table,
        sum(bytes_on_disk) AS current_bytes,
        sumIf(bytes_on_disk, modification_time >= now() - INTERVAL 24 HOUR) AS new_bytes_24h
    FROM system.parts
    WHERE active = 1
    GROUP BY database, table
)
SELECT
    database,
    table,
    formatReadableSize(current_bytes) AS current_h,
    formatReadableSize(new_bytes_24h) AS new_24h_h,
    round(new_bytes_24h / nullIf(current_bytes, 0) * 100, 2) AS growth_pct
FROM parts
WHERE new_bytes_24h > 10 * 1024 * 1024 * 1024
ORDER BY new_bytes_24h DESC
LIMIT 50
