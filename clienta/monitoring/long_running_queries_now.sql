-- title: Queries running longer than 5 minutes
-- description: Lists queries currently running for more than 5 minutes, with elapsed time, memory usage, rows read, and a preview of the query text.
-- severity: warning
-- category: Queries
SELECT
    query_id,
    user,
    elapsed,
    formatReadableSize(memory_usage) AS memory_h,
    read_rows,
    substring(query, 1, 200) AS query_preview
FROM system.processes
WHERE elapsed > 300
ORDER BY elapsed DESC
