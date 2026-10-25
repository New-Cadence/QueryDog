-- title: Broken or nearly full disks
-- description: Reports disks that are broken or below 10 percent free, including read-only state and unreserved capacity. Excludes object-storage disks that do not report capacity.
-- severity: info
-- category: Resources
SELECT
    hostname()     AS host,
    name           AS disk_name,
    type,
    path,
    is_broken,
    is_read_only,
    formatReadableSize(total_space)                                     AS total,
    formatReadableSize(free_space)                                      AS free,
    formatReadableSize(unreserved_space)                                AS unreserved,
    round(free_space / nullIf(total_space, 0) * 100, 2)                 AS free_pct,
    'CRIT' AS severity
FROM system.disks
WHERE total_space > 0  -- exclude object-storage disks that don't report capacity
  AND (is_broken = 1 OR free_space / total_space < 0.10)
ORDER BY free_pct ASC
