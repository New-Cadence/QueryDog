-- title: Query errors per minute (last 15 minutes)
-- description: Counts query log errors per minute, host, and error code over the last 15 minutes, ignoring benign client cancellations. Surfaces minutes with more than 10 errors so you can spot bursts of failures.
-- severity: warning
-- category: Queries
SELECT
    hostname()                             AS host,
    toStartOfMinute(event_time)            AS minute,
    type,
    exception_code,
    errorCodeToName(exception_code)        AS exception_name,
    count()                                AS error_count,
    any(exception)                         AS sample_exception,
    any(query_id)                          AS sample_query_id,
    multiIf(count() > 100, 'CRIT', count() > 10, 'WARN', 'OK') AS severity
FROM system.query_log
WHERE event_time >= now() - INTERVAL 15 MINUTE
  AND type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')
  -- ignore client cancellations (code 394 = QUERY_WAS_CANCELLED) which are usually benign
  AND exception_code != 394
GROUP BY host, minute, type, exception_code
HAVING error_count > 10
ORDER BY minute DESC, error_count DESC
LIMIT 100
