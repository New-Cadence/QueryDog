-- title: Concurrent queries near the server limit
-- description: Compares current active query count against the configured max_concurrent_queries limit per host and flags hosts running above 70 percent of that limit. Useful for spotting queue pressure before queries start getting rejected.
-- severity: info
-- category: Queries
WITH metrics_by_host AS (
    SELECT
        hostname()                              AS host,
        maxIf(value, metric = 'Query')          AS active_queries,
        maxIf(value, metric = 'HTTPConnection') AS http_conns,
        maxIf(value, metric = 'TCPConnection')  AS tcp_conns
    FROM system.metrics
    WHERE metric IN ('Query', 'HTTPConnection', 'TCPConnection')
    GROUP BY host
),
limits_by_host AS (
    -- max_concurrent_queries comes from server config; 0 = unlimited.
    SELECT hostname() AS host, toUInt64(value) AS max_concurrent
    FROM system.server_settings
    WHERE name = 'max_concurrent_queries'
)
SELECT
    m.host                                                                          AS host,
    m.active_queries                                                                AS active_queries,
    l.max_concurrent                                                                AS max_concurrent,
    m.http_conns                                                                    AS http_connections,
    m.tcp_conns                                                                     AS tcp_connections,
    if(l.max_concurrent = 0, 0,
       round(m.active_queries / l.max_concurrent * 100, 1))                         AS pct_of_limit,
    multiIf(
        l.max_concurrent > 0 AND m.active_queries / l.max_concurrent > 0.90, 'CRIT',
        l.max_concurrent > 0 AND m.active_queries / l.max_concurrent > 0.70, 'WARN',
        'OK'
    ) AS severity
FROM metrics_by_host m
JOIN limits_by_host l ON m.host = l.host
WHERE l.max_concurrent > 0
  AND m.active_queries / l.max_concurrent > 0.70
ORDER BY pct_of_limit DESC
