-- title: Hosts above 75% memory use
-- description: Compares tracked memory to total OS memory per host and flags hosts above 75 percent, with a breakdown of memory consumed by active queries.
-- severity: warning
-- category: Resources
SELECT
    host,
    formatReadableSize(toUInt64(tracked))         AS tracked_memory,
    formatReadableSize(toUInt64(os_total))        AS os_total_memory,
    round(tracked / nullIf(os_total, 0) * 100, 2) AS tracked_pct_of_os,
    formatReadableSize(toUInt64(queries_mem))     AS active_queries_memory,
    formatReadableSize(toUInt64(queries_peak))    AS active_queries_peak,
    multiIf(
        tracked / nullIf(os_total, 0) > 0.90, 'CRIT',
        tracked / nullIf(os_total, 0) > 0.75, 'WARN',
        'OK'
    ) AS severity
FROM (
    SELECT
        hostname()                                  AS host,
        maxIf(value, metric = 'TrackedMemory')          AS tracked,
        maxIf(value, metric = 'OSMemoryTotal')          AS os_total,
        maxIf(value, metric = 'QueriesMemoryUsage')     AS queries_mem,
        maxIf(value, metric = 'QueriesPeakMemoryUsage') AS queries_peak
    FROM system.asynchronous_metrics
    WHERE metric IN ('TrackedMemory', 'OSMemoryTotal',
                     'QueriesMemoryUsage', 'QueriesPeakMemoryUsage')
    GROUP BY host
)
WHERE tracked / nullIf(os_total, 0) > 0.75
ORDER BY tracked_pct_of_os DESC
