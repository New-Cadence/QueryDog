-- title: Read-only replicas or expired ZooKeeper sessions
-- description: Lists replicated tables whose replica is currently read-only or has an expired ZooKeeper session, which typically means writes are blocked.
-- severity: critical
-- category: Replication
SELECT
    database,
    table,
    replica_name,
    is_readonly,
    is_session_expired,
    queue_size,
    absolute_delay
FROM system.replicas
WHERE is_readonly = 1 OR is_session_expired = 1
