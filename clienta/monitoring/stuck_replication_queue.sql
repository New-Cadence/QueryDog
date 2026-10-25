-- title: Replication tasks failing or postponed
-- description: Lists replication queue tasks that have failed many times, been postponed often, or recorded an exception, with task type, age, and the last exception text.
-- severity: critical
-- category: Replication
SELECT
    hostname() AS host,
    database,
    table,
    replica_name,
    type                                         AS task_type,
    new_part_name,
    create_time,
    now() - create_time                          AS age_seconds,
    formatReadableTimeDelta(now() - create_time) AS age,
    num_tries,
    num_postponed,
    last_postpone_time,
    substring(last_exception, 1, 300)            AS last_exception_preview,
    substring(postpone_reason, 1, 200)           AS postpone_reason,
    multiIf(
        num_tries > 100 OR num_postponed > 1000, 'CRIT',
        num_tries > 10 OR num_postponed > 100 OR last_exception != '', 'WARN',
        'OK'
    ) AS severity
FROM system.replication_queue
WHERE num_tries > 10
   OR num_postponed > 100
   OR last_exception != ''
ORDER BY num_tries DESC, num_postponed DESC
LIMIT 100
