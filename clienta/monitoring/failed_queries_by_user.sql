-- title: Users with many failed queries (last hour)
-- description: Counts failed queries per user over the last hour, surfacing anyone with more than 10 failures along with the most recent error.
-- severity: info
-- category: Queries
SELECT
    user,
    count() AS failed_count,
    uniqExact(exception_code) AS distinct_error_codes,
    max(event_time) AS last_failure,
    any(substring(exception, 1, 200)) AS sample_exception
FROM system.query_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND exception_code > 0
GROUP BY user
HAVING failed_count > 10
ORDER BY failed_count DESC
