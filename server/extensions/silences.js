// Silences for the Testing and Data Quality check runners - see
// server/extensions/index.js for the ctx contract. A silenced check is skipped
// by Run all until the silence ends; it can still be run on its own.
// Monitoring keeps its own silences in alerting.js, where they also stop
// notifications. Same shape in both: { id, check, until, reason, createdAt }.
// Stored in the SQLite database (server/db.js).
import crypto from 'crypto';
import { getDb } from '../db.js';

const AREAS = ['testing', 'dataquality'];

export function register(app) {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS silences (
      id         TEXT PRIMARY KEY,
      area       TEXT NOT NULL,           -- testing | dataquality
      check_id   TEXT NOT NULL,
      until      TEXT NOT NULL,           -- ISO-8601 UTC
      reason     TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS silences_by_area ON silences (area, until);
  `);

  // Active silences for an area; expired ones are deleted as they are read
  const active = (area) => {
    const now = new Date().toISOString();
    db.prepare('DELETE FROM silences WHERE until <= ?').run(now);
    return db.prepare('SELECT id, check_id AS "check", until, reason, created_at AS createdAt FROM silences WHERE area = ? ORDER BY until')
      .all(area);
  };

  const area = (req, res) => {
    if (AREAS.includes(req.params.area)) return req.params.area;
    res.status(404).json({ error: 'Unknown area' });
    return null;
  };

  app.get('/api/silences/:area', (req, res) => {
    const a = area(req, res);
    if (a) res.json(active(a));
  });

  app.post('/api/silences/:area', (req, res) => {
    const a = area(req, res);
    if (!a) return;
    const { check, until, minutes, reason } = req.body || {};
    if (typeof check !== 'string' || !check || check.length > 300) return res.status(400).json({ error: 'check is required' });
    const untilMs = until ? new Date(until).getTime() : Date.now() + Number(minutes) * 60000;
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return res.status(400).json({ error: 'Silence must end in the future' });
    const silence = {
      id: `sil_${crypto.randomBytes(6).toString('hex')}`,
      check,
      until: new Date(untilMs).toISOString(),
      reason: String(reason || '').slice(0, 500),
      createdAt: new Date().toISOString(),
    };
    // One silence per check: a new one replaces it
    db.prepare('DELETE FROM silences WHERE area = ? AND check_id = ?').run(a, check);
    db.prepare('INSERT INTO silences (id, area, check_id, until, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(silence.id, a, check, silence.until, silence.reason, silence.createdAt);
    res.json(silence);
  });

  app.delete('/api/silences/:area/:id', (req, res) => {
    const a = area(req, res);
    if (!a) return;
    db.prepare('DELETE FROM silences WHERE area = ? AND id = ?').run(a, req.params.id);
    res.json({ success: true });
  });
}
