-- title: Replicas lagging by more than 60 seconds
-- description: Lists replicas with more than 60 seconds of absolute delay, along with queue size, insert and merge backlog, and read-only or expired session state.
-- severity: critical
-- category: Replication
SELECT
    database,
    table,
    replica_name,
    absolute_delay,
    queue_size,
    inserts_in_queue,
    merges_in_queue,
    is_readonly,
    is_session_expired
FROM system.replicas
WHERE absolute_delay > 60
ORDER BY absolute_delay DESC
