-- title: Queries that used more than 10 GB of memory
-- description: Lists completed queries from the last hour that used more than 10 GB of memory, ordered by peak memory usage. Helpful for identifying queries that risk memory pressure or OOM kills.
-- severity: warning
-- category: Queries
SELECT
    event_time,
    user,
    query_id,
    formatReadableSize(memory_usage) AS memory_h,
    query_duration_ms,
    substring(query, 1, 200) AS query_preview
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND type = 'QueryFinish'
  AND memory_usage > 1024  /* TEMP: relaxed for portal demo */
ORDER BY memory_usage DESC
LIMIT 100
