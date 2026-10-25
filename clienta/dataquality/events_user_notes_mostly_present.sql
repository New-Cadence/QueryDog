-- title: Event notes are mostly filled in
-- category: Events
-- description: Up to 15% of events may have no notes (about 10% today); more suggests the notes field stopped being captured.
-- table: default.events
-- severity: info
-- threshold: 15
SELECT * FROM default.events WHERE user_notes IS NULL OR user_notes = ''
