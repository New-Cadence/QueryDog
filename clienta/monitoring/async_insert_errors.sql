-- title: Failed async inserts (last hour)
-- description: Lists async insert attempts from the last hour that did not finish with status Ok, including the exception and how many rows or bytes were affected.
-- severity: warning
-- category: Inserts
SELECT
    event_time,
    database,
    table,
    status,
    exception,
    rows,
    bytes
FROM system.asynchronous_insert_log
WHERE event_time >= now() - INTERVAL 1 HOUR
  AND status != 'Ok'
ORDER BY event_time DESC
LIMIT 100
