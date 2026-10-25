-- title: Inserts throttled or rejected
-- description: Reports insert throttling and rejection event counters per host alongside server uptime, computing a rough rate per second. Surfaces hosts where inserts are being delayed or rejected, often due to too-many-parts back-pressure.
-- severity: critical
-- category: Inserts
WITH uptime_by_host AS (
    SELECT hostname() AS host, value AS uptime_sec
    FROM system.asynchronous_metrics
    WHERE metric = 'Uptime'
),
events_by_host AS (
    SELECT hostname() AS host, event, value, description
    FROM system.events
    WHERE event IN (
            'DelayedInserts',
            'DelayedInsertsMilliseconds',
            'RejectedInserts',
            'FailedInsertQuery',
            'TooManyParts'
          )
      AND value > 0
)
SELECT
    e.host                                          AS host,
    e.event                                         AS event,
    e.value                                         AS total_count,
    e.description                                   AS description,
    round(e.value / nullIf(u.uptime_sec, 0), 4)     AS rate_per_sec,
    multiIf(
        e.event IN ('RejectedInserts', 'FailedInsertQuery') AND e.value > 0, 'CRIT',
        e.event = 'DelayedInserts' AND e.value > 0, 'WARN',
        e.event = 'DelayedInsertsMilliseconds' AND e.value > 60000, 'WARN',
        'OK'
    ) AS severity
FROM events_by_host e
JOIN uptime_by_host u ON e.host = u.host
ORDER BY severity, e.event
