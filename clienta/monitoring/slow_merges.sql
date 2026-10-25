-- title: Merges running longer than 30 minutes
-- description: Lists merges that have been running for more than 30 minutes, with elapsed time, progress, part counts, source size, memory usage, and merge type. Helpful for spotting merges that are stuck or making no progress.
-- severity: warning
-- category: Parts & merges
SELECT
    hostname() AS host,
    database,
    table,
    elapsed                                            AS elapsed_seconds,
    formatReadableTimeDelta(elapsed)                   AS elapsed_human,
    round(progress * 100, 2)                           AS progress_pct,
    is_mutation,
    num_parts,
    result_part_name,
    formatReadableSize(total_size_bytes_compressed)    AS source_compressed,
    formatReadableSize(memory_usage)                   AS memory,
    merge_type,
    merge_algorithm,
    multiIf(
        elapsed > 7200, 'CRIT',
        elapsed > 600 AND progress < 0.01, 'CRIT',
        elapsed > 1800, 'WARN',
        'OK'
    ) AS severity
FROM system.merges
WHERE elapsed > 1800
ORDER BY elapsed DESC
LIMIT 50
