-- title: Queries slower than 1 minute (last 15 minutes)
-- description: Lists finished queries from the last 15 minutes that ran longer than 1 minute, with duration, memory, rows and bytes read, result size, and a query preview.
-- severity: warning
-- category: Queries
SELECT
    hostname() AS host,
    event_time,
    query_id,
    user,
    initial_user,
    query_duration_ms / 1000.0                  AS duration_sec,
    formatReadableSize(memory_usage)            AS memory,
    read_rows,
    formatReadableSize(read_bytes)              AS read,
    result_rows,
    formatReadableSize(result_bytes)            AS result,
    type,
    substring(query, 1, 300)                    AS query_preview,
    multiIf(
        query_duration_ms > 600000
            OR read_rows > 10000000000
            OR memory_usage > 16 * 1024 * 1024 * 1024, 'CRIT',
        query_duration_ms > 60000, 'WARN',
        'OK'
    ) AS severity
FROM system.query_log
WHERE event_time >= now() - INTERVAL 15 MINUTE
  AND type = 'QueryFinish'
  AND query_duration_ms > 60000           -- > 1 minute
  AND query NOT ILIKE '%system.query_log%' -- ignore this query itself
ORDER BY query_duration_ms DESC
LIMIT 50
