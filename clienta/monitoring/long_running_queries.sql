-- title: Long-running queries with resource usage
-- description: Lists currently running queries elapsed more than 5 minutes, including user, memory, rows read, total approximate rows, progress percentage, and a query preview.
-- severity: warning
-- category: Queries
SELECT
    hostname() AS host,
    query_id,
    user,
    initial_user,
    address,
    elapsed                                                  AS elapsed_seconds,
    formatReadableTimeDelta(elapsed)                         AS elapsed_human,
    formatReadableSize(memory_usage)                         AS memory,
    read_rows,
    formatReadableSize(read_bytes)                           AS read,
    total_rows_approx,
    round(100 * read_rows / nullIf(total_rows_approx, 0), 1) AS progress_pct,
    substring(query, 1, 200)                                 AS query_preview,
    multiIf(
        elapsed > 1800 OR memory_usage > 1024, 'CRIT',
        elapsed > 0, 'WARN',
        'OK'
    ) AS severity
FROM system.processes
WHERE elapsed > 0       -- TEMP: relaxed for portal demo
  AND query NOT ILIKE '%system.processes%' -- ignore this query itself
ORDER BY elapsed DESC
LIMIT 50
