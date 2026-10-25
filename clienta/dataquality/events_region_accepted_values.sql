-- title: Event regions are known regions
-- category: Events
-- description: Region must be us, eu or apac.
-- table: default.events
-- severity: warning
SELECT * FROM default.events WHERE region NOT IN ('us', 'eu', 'apac')
