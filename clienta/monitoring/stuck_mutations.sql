-- title: Mutations pending for over an hour
-- description: Lists mutations that have been pending for more than an hour without being killed, including age, parts remaining, and any recent failure reason. Old unfinished mutations usually indicate a stuck ALTER that needs attention.
-- severity: critical
-- category: Mutations
SELECT
    hostname() AS host,
    database,
    table,
    mutation_id,
    substring(command, 1, 200)             AS command_preview,
    create_time,
    now() - create_time                    AS age_seconds,
    formatReadableTimeDelta(now() - create_time) AS age,
    parts_to_do,
    is_done,
    is_killed,
    latest_failed_part,
    latest_fail_time,
    latest_fail_error_code_name,
    substring(latest_fail_reason, 1, 200)  AS fail_reason_preview,
    multiIf(
        latest_fail_time > now() - INTERVAL 1 HOUR
            OR (is_done = 0 AND create_time < now() - INTERVAL 24 HOUR),
        'CRIT',
        is_done = 0 AND create_time < now() - INTERVAL 1 HOUR,
        'WARN',
        'OK'
    ) AS severity
FROM system.mutations
WHERE is_done = 0
  AND is_killed = 0
  AND create_time < now() - INTERVAL 1 HOUR
ORDER BY create_time ASC
LIMIT 100
