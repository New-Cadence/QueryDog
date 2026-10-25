-- title: ZooKeeper and Keeper error counters
-- description: Reports ZooKeeper, Keeper, and replication-related event counters since server start, with a per-second rate based on uptime. Highlights hardware exceptions, data loss events, and replicas diverging after merges or mutations.
-- severity: critical
-- category: Replication
WITH uptime_by_host AS (
    SELECT hostname() AS host, value AS uptime_sec
    FROM system.asynchronous_metrics
    WHERE metric = 'Uptime'
),
events_by_host AS (
    SELECT hostname() AS host, event, value, description
    FROM system.events
    WHERE (
            event IN (
                'ZooKeeperHardwareExceptions',
                'ZooKeeperUserExceptions',
                'ZooKeeperOtherExceptions',
                'ReplicatedDataLoss',
                'DataAfterMergeDiffersFromReplica',
                'DataAfterMutationDiffersFromReplica'
            )
            OR event ILIKE 'ReplicatedPart%Fail%'
          )
      AND value > 0
)
SELECT
    e.host                                     AS host,
    e.event                                    AS event,
    e.value                                    AS occurrences_since_start,
    e.description                              AS description,
    toUInt64(u.uptime_sec)                     AS server_uptime_sec,
    round(e.value / nullIf(u.uptime_sec, 0), 4) AS rate_per_sec,
    multiIf(
        e.event = 'ReplicatedDataLoss' AND e.value > 0, 'CRIT',
        e.event = 'ZooKeeperHardwareExceptions' AND e.value > 0, 'WARN',
        e.event = 'DataAfterMergeDiffersFromReplica' AND e.value > 0, 'CRIT',
        e.event = 'DataAfterMutationDiffersFromReplica' AND e.value > 0, 'CRIT',
        e.event ILIKE 'ReplicatedPart%Fail%' AND e.value > 10, 'WARN',
        'OK'
    ) AS severity
FROM events_by_host e
JOIN uptime_by_host u ON e.host = u.host
ORDER BY severity, e.value DESC
