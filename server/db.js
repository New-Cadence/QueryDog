// Convoy's own database: a SQLite file (node:sqlite, built into
// Node 22+) holding settings, check run results, recommendations and the
// scheduler log, so they survive restarts and are shared by every viewer.
//   <dataDir>/querydog.db   (QUERYDOG_DATA_DIR overrides dataDir)
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const RUN_RETENTION_DAYS = Number(process.env.QUERYDOG_RUN_RETENTION_DAYS) || 30;
const LOG_RETENTION_DAYS = 7;

let db = null;

export function dataDir() {
  return process.env.QUERYDOG_DATA_DIR || path.join(process.cwd(), 'data');
}

export function getDb() {
  if (db) return db;
  fs.mkdirSync(dataDir(), { recursive: true });
  db = new DatabaseSync(path.join(dataDir(), 'querydog.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    -- One row per run of a check, from the UI or the scheduler.
    -- kind: monitoring | dataquality | performance; check_id: file name or rule id
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      check_id    TEXT NOT NULL,
      environment TEXT NOT NULL,
      trigger     TEXT NOT NULL,          -- manual | scheduler
      started_at  TEXT NOT NULL,          -- ISO-8601 UTC
      duration_ms INTEGER,
      status      TEXT NOT NULL,          -- ok | warn | fail | error
      row_count   INTEGER,
      detail      TEXT,
      error       TEXT,
      query_id    TEXT,
      read_rows   INTEGER,
      read_bytes  INTEGER
    );
    CREATE INDEX IF NOT EXISTS runs_by_check ON runs (kind, check_id, environment, started_at);
    CREATE INDEX IF NOT EXISTS runs_by_time ON runs (started_at);

    -- What the scheduler did, for monitoring it from Settings and the logs
    CREATE TABLE IF NOT EXISTS scheduler_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      time        TEXT NOT NULL,
      level       TEXT NOT NULL,          -- info | warn | error
      environment TEXT,
      kind        TEXT,
      message     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduler_log_by_time ON scheduler_log (time);

    -- Everything saved from the Settings area, one JSON document per key
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,           -- JSON
      updated_at TEXT NOT NULL
    );

    -- Recommendations and their triage state, per environment
    CREATE TABLE IF NOT EXISTS recommendations (
      environment  TEXT NOT NULL,
      id           TEXT NOT NULL,
      category     TEXT,
      severity     TEXT,
      status       TEXT NOT NULL,         -- open | acknowledged | snoozed | dismissed | resolved
      first_seen   TEXT,
      last_seen    TEXT,
      changed_at   TEXT,
      snooze_until TEXT,
      reason       TEXT,
      rec          TEXT NOT NULL,         -- JSON of the recommendation
      PRIMARY KEY (environment, id)
    );
  `);
  // Columns added after the first release of the runs table
  const runColumns = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  for (const [col, type] of [['read_rows', 'INTEGER'], ['read_bytes', 'INTEGER']]) {
    if (!runColumns.has(col)) db.exec(`ALTER TABLE runs ADD COLUMN ${col} ${type}`);
  }
  prune();
  return db;
}

function prune() {
  const runCutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 86400000).toISOString();
  const logCutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 86400000).toISOString();
  db.prepare('DELETE FROM runs WHERE started_at < ?').run(runCutoff);
  db.prepare('DELETE FROM scheduler_log WHERE time < ?').run(logCutoff);
}
setInterval(() => { if (db) prune(); }, 6 * 3600000).unref();

export function recordCheckRun(run) {
  const r = {
    kind: run.kind, check_id: run.checkId, environment: run.environment, trigger: run.trigger || 'manual',
    started_at: run.startedAt || new Date().toISOString(), duration_ms: run.durationMs ?? null, status: run.status,
    row_count: run.rowCount ?? null, detail: run.detail ?? null, error: run.error ? String(run.error).slice(0, 2000) : null,
    query_id: run.queryId ?? null, read_rows: run.readRows ?? null, read_bytes: run.readBytes ?? null,
  };
  getDb().prepare(`INSERT INTO runs (kind, check_id, environment, trigger, started_at, duration_ms, status, row_count, detail, error, query_id, read_rows, read_bytes)
    VALUES (:kind, :check_id, :environment, :trigger, :started_at, :duration_ms, :status, :row_count, :detail, :error, :query_id, :read_rows, :read_bytes)`).run(r);
}

// Per-check statistics for one kind and environment, as the check grids show
// them: last run, average / fastest / slowest time, run count and the newest
// runs (oldest first) for the history sparkline. Errors count as runs but not
// towards timings.
export function runStats(kind, environment, historyLength = 30) {
  const d = getDb();
  const out = new Map();
  const rows = d.prepare(`
    SELECT check_id,
           count(*) AS run_count,
           avg(CASE WHEN status != 'error' THEN duration_ms END) AS avg_ms,
           min(CASE WHEN status != 'error' THEN duration_ms END) AS min_ms,
           max(CASE WHEN status != 'error' THEN duration_ms END) AS max_ms
    FROM runs WHERE kind = ? AND environment = ? GROUP BY check_id`).all(kind, environment);
  const recent = d.prepare(`
    SELECT * FROM (
      SELECT id, check_id, started_at, duration_ms, row_count, status, error,
             row_number() OVER (PARTITION BY check_id ORDER BY started_at DESC, id DESC) AS rn
      FROM runs WHERE kind = ? AND environment = ?)
    WHERE rn <= ? ORDER BY check_id, started_at, id`).all(kind, environment, historyLength);
  const byCheck = new Map();
  for (const r of recent) {
    if (!byCheck.has(r.check_id)) byCheck.set(r.check_id, []);
    byCheck.get(r.check_id).push(r);
  }
  for (const r of rows) {
    const history = byCheck.get(r.check_id) || [];
    const last = history[history.length - 1];
    out.set(r.check_id, {
      runCount: r.run_count,
      lastRunTime: last?.started_at ?? null,
      lastDuration: last?.duration_ms ?? null,
      lastRowCount: last?.row_count ?? null,
      lastStatus: last?.status ?? null,
      lastError: last?.error ?? null,
      avgRunTime: r.avg_ms === null ? null : Math.round(r.avg_ms),
      fastestRunTime: r.min_ms,
      slowestRunTime: r.max_ms,
      history: history.map(h => ({ time: h.started_at, duration: h.duration_ms, rows: h.row_count, status: h.status })),
    });
  }
  return out;
}

// Newest runs of one check, for the run log
export function runLog(kind, checkId, environment, limit = 50) {
  return getDb().prepare(`SELECT * FROM runs WHERE kind = ? AND check_id = ? AND environment = ?
    ORDER BY started_at DESC, id DESC LIMIT ?`).all(kind, checkId, environment, limit).map(r => ({
    queryId: r.query_id, runTime: r.started_at, duration: r.duration_ms, rowCount: r.row_count,
    readRows: r.read_rows, readBytes: r.read_bytes, status: r.status, error: r.error, trigger: r.trigger,
  }));
}

export function clearRuns(kind, environment, checkId = null) {
  if (checkId) getDb().prepare('DELETE FROM runs WHERE kind = ? AND environment = ? AND check_id = ?').run(kind, environment, checkId);
  else getDb().prepare('DELETE FROM runs WHERE kind = ? AND environment = ?').run(kind, environment);
}

export function listRuns({ kind, checkId, environment, since, limit = 200 } = {}) {
  const where = [];
  const params = { limit: Math.min(Number(limit) || 200, 20000) };
  if (since) { where.push('started_at >= :since'); params.since = String(since); }
  if (kind) { where.push('kind = :kind'); params.kind = kind; }
  if (checkId) { where.push('check_id = :check_id'); params.check_id = checkId; }
  if (environment) { where.push('environment = :environment'); params.environment = environment; }
  return getDb().prepare(`SELECT * FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT :limit`).all(params);
}

export function logScheduler(level, message, { environment = null, kind = null } = {}) {
  const time = new Date().toISOString();
  getDb().prepare('INSERT INTO scheduler_log (time, level, environment, kind, message) VALUES (?, ?, ?, ?, ?)')
    .run(time, level, environment, kind, message);
  const where = [environment, kind].filter(Boolean).join('/');
  const line = `[scheduler] ${time} ${level.toUpperCase()}${where ? ` ${where}` : ''}: ${message}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export function listSchedulerLog(limit = 200) {
  return getDb().prepare('SELECT * FROM scheduler_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 200, 2000));
}

// ==================== Settings ====================

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  getDb().prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), new Date().toISOString());
}

// Import of a setting that used to live in a JSON file under dataDir. The
// file is renamed to <name>.migrated afterwards. A file newer than the stored
// copy (written by an older server still running) replaces it.
export function importJsonFile(key, file, transform = v => v) {
  const full = path.join(dataDir(), file);
  if (!fs.existsSync(full)) return;
  try {
    const stored = getDb().prepare('SELECT updated_at FROM settings WHERE key = ?').get(key);
    if (!stored || fs.statSync(full).mtime.toISOString() > stored.updated_at) {
      setSetting(key, transform(JSON.parse(fs.readFileSync(full, 'utf-8'))));
    }
    fs.renameSync(full, `${full}.migrated`);
    console.log(`Moved ${file} into ${path.join(dataDir(), 'querydog.db')} (${key})`);
  } catch (e) {
    console.error(`Could not import ${file}:`, e.message);
  }
}

// ==================== Recommendations ====================

export function listRecommendations(environment) {
  return getDb().prepare('SELECT * FROM recommendations WHERE environment = ?').all(environment).map(r => ({
    rec: JSON.parse(r.rec),
    status: r.status,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    ...(r.changed_at ? { changedAt: r.changed_at } : {}),
    ...(r.snooze_until ? { snoozeUntil: r.snooze_until } : {}),
    ...(r.reason ? { reason: r.reason } : {}),
  }));
}

// Set the triage status of some recommendations (acknowledge, snooze, ...)
// without touching the rest, so it can't overwrite results of a newer run
export function setRecommendationStatus(environment, ids, status, { snoozeUntil = null, reason = null } = {}) {
  const now = new Date().toISOString();
  const update = getDb().prepare(`UPDATE recommendations SET status = ?, changed_at = ?, snooze_until = ?, reason = ?
    WHERE environment = ? AND id = ?`);
  let changed = 0;
  for (const id of ids) changed += Number(update.run(status, now, snoozeUntil, reason, environment, String(id)).changes);
  return changed;
}

// Replace an environment's recommendations with the given triage entries
export function saveRecommendations(environment, entries) {
  const d = getDb();
  const insert = d.prepare(`INSERT INTO recommendations
    (environment, id, category, severity, status, first_seen, last_seen, changed_at, snooze_until, reason, rec)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  d.exec('BEGIN');
  try {
    d.prepare('DELETE FROM recommendations WHERE environment = ?').run(environment);
    for (const e of entries) {
      if (!e?.rec?.id) continue;
      insert.run(environment, String(e.rec.id), e.rec.category ?? null, e.rec.severity ?? null, String(e.status || 'open'),
        e.firstSeen ?? null, e.lastSeen ?? null, e.changedAt ?? null, e.snoozeUntil ?? null, e.reason ?? null, JSON.stringify(e.rec));
    }
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}
