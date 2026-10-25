-- title: Dictionaries that failed to load
-- description: Lists dictionaries that failed to load or have a non-empty last exception. Stale or unloaded dictionaries can silently break queries that depend on them.
-- severity: info
-- category: Dictionaries
SELECT
    database,
    name,
    status,
    last_exception,
    loading_start_time,
    loading_duration
FROM system.dictionaries
WHERE status IN ('FAILED', 'FAILED_AND_RELOADING')
   OR last_exception != ''
