-- title: Dictionaries failing or stuck reloading
-- description: Surfaces dictionaries in failed states, those with a recorded exception, or those stuck reloading for more than 10 minutes, along with element counts, timing, and a truncated exception message.
-- severity: critical
-- category: Dictionaries
SELECT
    hostname() AS host,
    database,
    name,
    status,
    source,
    type,
    element_count,
    bytes_allocated,
    last_successful_update_time,
    now() - last_successful_update_time AS seconds_since_success,
    loading_duration,
    substring(last_exception, 1, 300)   AS last_exception,
    multiIf(
        status IN ('FAILED', 'FAILED_AND_RELOADING'), 'CRIT',
        last_exception != '', 'CRIT',
        status = 'LOADED_AND_RELOADING'
            AND loading_start_time < now() - INTERVAL 10 MINUTE, 'WARN',
        'OK'
    ) AS severity
FROM system.dictionaries
WHERE status IN ('FAILED', 'FAILED_AND_RELOADING')
   OR last_exception != ''
   OR (status = 'LOADED_AND_RELOADING'
       AND loading_start_time < now() - INTERVAL 10 MINUTE)
ORDER BY severity, name
LIMIT 100
