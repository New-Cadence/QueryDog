-- title: Server errors in the last 5 minutes
-- description: Lists distinct server errors recorded in the last 5 minutes, excluding noisy user-facing errors like syntax or unknown identifier. Highlights infrastructure-level problems such as corruption, disk space, memory limits, and Keeper exceptions.
-- severity: warning
-- category: Errors & logs
SELECT
    hostname()                          AS host,
    name                                AS error_name,
    code                                AS error_code,
    value                               AS occurrences_total,
    last_error_time,
    now() - last_error_time             AS seconds_since_last,
    remote,
    substring(last_error_message, 1, 300) AS last_error_message,
    multiIf(
        name IN (
            'CORRUPTED_DATA',
            'CHECKSUM_DOESNT_MATCH',
            'NO_FREE_SPACE',
            'NOT_ENOUGH_SPACE',
            'MEMORY_LIMIT_EXCEEDED',
            'TOO_MANY_PARTS',
            'TABLE_IS_READ_ONLY',
            'KEEPER_EXCEPTION',
            'SYSTEM_ERROR',
            'CANNOT_ALLOCATE_MEMORY',
            'CANNOT_OPEN_FILE',
            'CANNOT_FSYNC'
        ),
        'CRIT',
        'WARN'
    ) AS severity
FROM system.errors
WHERE last_error_time >= now() - INTERVAL 5 MINUTE
  -- ignore self-inflicted user errors that are loud but harmless
  AND name NOT IN (
        'UNKNOWN_TABLE', 'UNKNOWN_DATABASE', 'UNKNOWN_FUNCTION',
        'UNKNOWN_IDENTIFIER', 'SYNTAX_ERROR', 'TYPE_MISMATCH',
        'AUTHENTICATION_FAILED', 'QUERY_WAS_CANCELLED'
  )
ORDER BY last_error_time DESC
LIMIT 100
