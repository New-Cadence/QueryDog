-- title: Queries slower than 30 seconds (last hour)
-- description: Lists queries from the last hour that took more than 30 seconds to finish, with duration, rows and bytes read, and a query preview.
-- severity: warning
-- category: Queries
SELECT
    event_time,
    user,
    query_id,
    query_duration_ms,
    read_rows,
    formatReadableSize(read_bytes) AS read_bytes_h,
    substring(query, 1, 200) AS query_preview
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND type = 'QueryFinish'
  AND query_duration_ms > 30000
ORDER BY query_duration_ms DESC
LIMIT 100
