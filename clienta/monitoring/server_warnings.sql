-- title: Server configuration and runtime warnings
-- description: Returns the contents of system.warnings per host, which ClickHouse populates with configuration and runtime warnings the operator should review.
-- severity: info
-- category: Errors & logs
SELECT
    hostname() AS host,
    message,
    message_format_string
FROM system.warnings
ORDER BY host, message
