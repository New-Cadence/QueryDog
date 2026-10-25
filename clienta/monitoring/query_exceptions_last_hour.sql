-- title: Queries that threw exceptions (last hour)
-- description: Lists queries that threw exceptions while processing over the last hour, with exception code, message, and a preview of the query.
-- severity: warning
-- category: Queries
SELECT
    event_time,
    user,
    query_id,
    exception_code,
    exception,
    substring(query, 1, 200) AS query_preview
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND exception_code > 0
  AND type = 'ExceptionWhileProcessing'
ORDER BY event_time DESC
LIMIT 100
