// Notebooks extension: notebooks are stored as one JSON file each under
// <dataDir>/notebooks/<id>.json, plus a query runner that tags each cell run
// with a query_id so the UI can look up its stats in system.query_log.
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import express from 'express';
import { isBlockedStatement } from '../sqlGuard.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SAVED_ROWS = 500;
const MAX_RESULT_ROWS = 10000;

// The global express.json() parser stops at 100kb. Notebook saves are sent as
// text/plain (which the global parser skips) and parsed here with a larger limit.
const bigJson = express.json({ limit: '25mb', type: ['application/json', 'text/plain'] });

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function register(app, ctx) {
  const dir = path.join(ctx.dataDir, 'notebooks');
  fs.mkdirSync(dir, { recursive: true });

  const fileFor = id => path.join(dir, `${id}.json`);

  const readNotebook = id => {
    try {
      return JSON.parse(fs.readFileSync(fileFor(id), 'utf-8'));
    } catch {
      return null;
    }
  };

  const writeNotebook = notebook => {
    const tmp = `${fileFor(notebook.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(notebook, null, 2));
    fs.renameSync(tmp, fileFor(notebook.id));
  };

  // Normalise an incoming notebook: force the id, stamp updatedAt and cap the
  // saved output of every cell so one big result can't bloat the file.
  const sanitize = (body, id) => ({
    ...body,
    id,
    title: String(body.title || 'Untitled notebook').slice(0, 200),
    updatedAt: new Date().toISOString(),
    cells: (Array.isArray(body.cells) ? body.cells : []).map(cell =>
      cell?.result && Array.isArray(cell.result.data)
        ? { ...cell, result: { ...cell.result, data: cell.result.data.slice(0, MAX_SAVED_ROWS) } }
        : cell),
  });

  const validId = (req, res) => {
    if (ID_PATTERN.test(req.params.id)) return true;
    res.status(400).json({ error: 'Invalid notebook id' });
    return false;
  };

  app.get('/api/notebooks', (req, res) => {
    try {
      const list = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => readNotebook(f.slice(0, -5)))
        .filter(nb => nb && Array.isArray(nb.cells))
        .map(nb => ({
          id: nb.id,
          title: nb.title,
          updatedAt: nb.updatedAt,
          template: nb.template || null,
          cellCount: nb.cells.length,
          cellTypes: [...new Set(nb.cells.map(c => c.type))],
        }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      res.json(list);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/notebooks/:id', (req, res) => {
    if (!validId(req, res)) return;
    const nb = readNotebook(req.params.id);
    if (!nb) return res.status(404).json({ error: 'Notebook not found' });
    res.json(nb);
  });

  app.post('/api/notebooks', bigJson, (req, res) => {
    try {
      if (!isObject(req.body)) return res.status(400).json({ error: 'Notebook JSON object required' });
      if (req.body.id !== undefined && !ID_PATTERN.test(req.body.id)) return res.status(400).json({ error: 'Invalid notebook id' });
      const id = req.body.id || randomUUID();
      if (fs.existsSync(fileFor(id))) return res.status(409).json({ error: 'Notebook already exists' });
      const nb = sanitize(req.body, id);
      writeNotebook(nb);
      res.status(201).json(nb);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/notebooks/:id', bigJson, (req, res) => {
    if (!validId(req, res)) return;
    if (!isObject(req.body)) return res.status(400).json({ error: 'Notebook JSON object required' });
    try {
      const nb = sanitize(req.body, req.params.id);
      writeNotebook(nb);
      res.json({ id: nb.id, updatedAt: nb.updatedAt });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/notebooks/:id', (req, res) => {
    if (!validId(req, res)) return;
    try {
      if (!fs.existsSync(fileFor(req.params.id))) return res.status(404).json({ error: 'Notebook not found' });
      fs.unlinkSync(fileFor(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run a cell. Same read-only guard as /api/query, but the row limit is applied
  // with max_result_rows (so any statement shape works) and the query_id is
  // returned for the stats lookup.
  app.post('/api/notebooks/run', async (req, res) => {
    const sql = String(req.body?.query || '').trim().replace(/;+\s*$/, '').replace(/\s+FORMAT\s+\w+\s*$/i, '');
    if (!sql) return res.status(400).json({ error: 'Query is required' });
    if (isBlockedStatement(sql)) {
      return res.status(403).json({ error: 'Dangerous operations are not allowed through this interface' });
    }
    const limit = Math.min(MAX_RESULT_ROWS, Math.max(1, parseInt(req.body?.limit, 10) || MAX_RESULT_ROWS));
    const queryId = randomUUID();
    const start = Date.now();
    try {
      const result = await ctx.getClient().query({
        query: sql,
        format: 'JSONEachRow',
        query_id: queryId,
        clickhouse_settings: {
          max_result_rows: String(limit + 1),
          result_overflow_mode: 'break',
          log_comment: 'querydog-notebook',
        },
      });
      const rows = await result.json();
      res.json({
        data: rows.slice(0, limit),
        rowCount: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        duration: Date.now() - start,
        queryId,
      });
    } catch (err) {
      res.status(400).json({ error: err.message, queryId });
    }
  });

  // Stats for one notebook run, from system.query_log. The logs are flushed once
  // per query so the entry shows up quickly (flushing writes every system log, so
  // the client's retries don't repeat it); a failed flush is ignored and the
  // client simply retries. 404 means "not logged (yet)".
  const flushedQueryIds = new Set();
  app.get('/api/notebooks/query-stats/:queryId', async (req, res) => {
    const { queryId } = req.params;
    if (!/^[0-9a-f-]{36}$/.test(queryId)) return res.status(400).json({ error: 'Invalid query id' });
    const client = ctx.getClient();
    const cluster = ctx.getActiveEnvironment()?.cluster;
    const table = cluster ? `clusterAllReplicas('${cluster.replace(/'/g, '')}', system.query_log)` : 'system.query_log';
    try {
      if (!flushedQueryIds.has(queryId)) {
        flushedQueryIds.add(queryId);
        if (flushedQueryIds.size > 1000) flushedQueryIds.delete(flushedQueryIds.values().next().value);
        await client.command({ query: 'SYSTEM FLUSH LOGS' }).catch(() => {});
      }
      const result = await client.query({
        query: `
          SELECT type, query_duration_ms, read_rows, read_bytes, result_rows, memory_usage, exception
          FROM ${table}
          WHERE event_date >= yesterday() AND query_id = {queryId:String} AND type != 'QueryStart'
          ORDER BY event_time_microseconds DESC
          LIMIT 1`,
        query_params: { queryId },
        format: 'JSONEachRow',
      });
      const [row] = await result.json();
      if (!row) return res.status(404).json({ error: 'Query not found in system.query_log yet' });
      res.json(row);
    } catch (err) {
      const missing = /UNKNOWN_TABLE|Unknown table|doesn't exist/i.test(err.message);
      res.status(missing ? 501 : 500).json({ error: missing ? 'system.query_log is not enabled on this server' : err.message });
    }
  });
}
