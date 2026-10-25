-- title: Replicated tables in poor health
-- description: Summarizes replicated tables that are read-only, session-expired, missing active replicas, or have large queues or replication delays.
-- severity: info
-- category: Replication
SELECT
    hostname() AS host,
    database,
    table,
    is_readonly,
    is_session_expired,
    future_parts,
    parts_to_check,
    queue_size,
    inserts_in_queue,
    merges_in_queue,
    part_mutations_in_queue,
    absolute_delay,
    total_replicas,
    active_replicas,
    multiIf(
        is_readonly = 1 OR is_session_expired = 1
            OR active_replicas < total_replicas
            OR future_parts > 100
            OR absolute_delay > 600,
        'CRIT',
        queue_size > 50 OR absolute_delay > 60,
        'WARN',
        'OK'
    ) AS severity
FROM system.replicas
WHERE is_readonly = 1
   OR is_session_expired = 1
   OR active_replicas < total_replicas
   OR future_parts > 100
   OR queue_size > 50
   OR absolute_delay > 60
ORDER BY severity, absolute_delay DESC, queue_size DESC
LIMIT 100
