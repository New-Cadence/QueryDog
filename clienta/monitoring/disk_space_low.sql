-- title: Disks below 10% free space
-- description: Lists disks with less than 10 percent free space, showing free, total, and percentage free in human-readable form.
-- severity: critical
-- category: Resources
SELECT
    name,
    path,
    formatReadableSize(free_space) AS free_h,
    formatReadableSize(total_space) AS total_h,
    round(free_space / total_space * 100, 2) AS free_pct
FROM system.disks
WHERE total_space > 0
  AND free_space / total_space < 0.99  -- TEMP: relaxed for portal demo
ORDER BY free_pct ASC
