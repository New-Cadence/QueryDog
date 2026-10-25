SELECT
    hostname()                                                 AS host,
    database,
    table,
    sum(rows)                                                  AS rows,
    formatReadableSize(sum(bytes_on_disk))                     AS size_on_disk,
    formatReadableSize(sum(data_uncompressed_bytes))           AS size_uncompressed,
    round(sum(data_uncompressed_bytes)
          / nullIf(sum(data_compressed_bytes), 0), 2)          AS compression_ratio,
    count()                                                    AS active_parts,
    min(min_time)                                              AS oldest_data,
    max(max_time)                                              AS newest_data,
    multiIf(
        sum(bytes_on_disk) > 1024 * 1024 * 1024 * 1024, 'TB+',
        'LARGE'
    ) AS size_class
FROM system.parts
WHERE active = 1
  AND database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')
GROUP BY host, database, table
HAVING sum(bytes_on_disk) > 100 * 1024 * 1024 * 1024
ORDER BY sum(bytes_on_disk) DESC
LIMIT 30
