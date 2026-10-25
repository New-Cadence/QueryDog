-- title: Users with a spike in query rate
-- description: Compares each user's queries-per-minute over the last 5 minutes against the prior hour baseline and flags users running at more than 3x their normal rate. Useful for detecting runaway clients or dashboard storms.
-- severity: info
-- category: Queries
WITH
    recent AS (
        SELECT user, count() / 5 AS recent_qpm
        FROM system.query_log
        WHERE event_time >= now() - INTERVAL 5 MINUTE
          AND type = 'QueryStart'
        GROUP BY user
    ),
    baseline AS (
        SELECT user, count() / 60 AS baseline_qpm
        FROM system.query_log
        WHERE event_time >= now() - INTERVAL 1 HOUR
          AND event_time <  now() - INTERVAL 5 MINUTE
          AND type = 'QueryStart'
        GROUP BY user
    )
SELECT
    recent.user AS user,
    round(recent.recent_qpm, 2) AS recent_qpm,
    round(baseline.baseline_qpm, 2) AS baseline_qpm,
    round(recent.recent_qpm / nullIf(baseline.baseline_qpm, 0), 2) AS multiplier
FROM recent
LEFT JOIN baseline ON recent.user = baseline.user
WHERE recent.recent_qpm > 5
  AND recent.recent_qpm > baseline.baseline_qpm * 3
ORDER BY multiplier DESC
