-- title: Queries killed for exceeding memory (last hour)
-- description: Lists queries from the last hour that failed with exception code 241 (memory limit exceeded), with user, memory usage, and a query preview.
-- severity: critical
-- category: Resources
SELECT
    event_time,
    user,
    query_id,
    exception,
    formatReadableSize(memory_usage) AS memory_h,
    substring(query, 1, 200) AS query_preview
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND exception_code = 241
ORDER BY event_time DESC
LIMIT 100
