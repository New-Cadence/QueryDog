// Data Dictionary extension: catalog, documentation edits, column profiling,
// lineage and usage insights. See server/extensions/index.js for the ctx contract.

const SYSTEM_DATABASES = ['system', 'INFORMATION_SCHEMA', 'information_schema'];
const PROFILE_SAMPLE_ROWS = 1_000_000;
const USAGE_DAYS = 7;

// `name` with embedded backticks escaped, safe to splice into SQL.
export function quoteIdent(name) {
  return '`' + String(name).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
}

// 'text' literal with backslashes and quotes escaped.
export function quoteString(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

async function queryRows(client, query, query_params = {}) {
  const result = await client.query({ query, query_params, format: 'JSONEachRow' });
  return result.json();
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// Column types that support min()/max() in a meaningful way.
function isOrderable(type) {
  let base = type;
  for (let m; (m = base.match(/^(?:Nullable|LowCardinality)\((.*)\)$/)); ) base = m[1];
  return /^(U?Int|Float|Decimal|Date|DateTime|String|FixedString|UUID|IPv4|IPv6|Enum|Bool)/.test(base);
}

// Look up a table, and optionally one of its columns, in the system catalog so
// only identifiers that really exist are ever spliced into SQL.
async function findTable(client, database, table) {
  const rows = await queryRows(
    client,
    `SELECT database, name, engine, sampling_key, toUInt64(ifNull(total_rows, 0)) AS total_rows
     FROM system.tables WHERE database = {database:String} AND name = {table:String}`,
    { database, table },
  );
  return rows[0] || null;
}

async function findColumn(client, database, table, column) {
  const rows = await queryRows(
    client,
    `SELECT name, type FROM system.columns
     WHERE database = {database:String} AND table = {table:String} AND name = {column:String}`,
    { database, table, column },
  );
  return rows[0] || null;
}

// --- Lineage -----------------------------------------------------------------

// [database, table] references in FROM / JOIN clauses of a view's SELECT
// (table functions such as numbers(10) are skipped).
function selectSources(sql, defaultDb) {
  const out = [];
  const re = /\b(?:FROM|JOIN)\s+((?:`[^`]+`|[A-Za-z_]\w*)(?:\.(?:`[^`]+`|[A-Za-z_]\w*))?)/gi;
  for (const m of sql.matchAll(re)) {
    if (sql[m.index + m[0].length] === '(') continue;
    const parts = m[1].match(/`[^`]+`|[^.]+/g).map(unquote);
    out.push(parts.length === 2 ? parts : [defaultDb, parts[0]]);
  }
  return out;
}

function unquote(s) {
  return s.trim().replace(/^['"`]|['"`]$/g, '');
}

// Every edge we can infer from system.tables, pointing in the direction data
// flows (source -> consumer). Nodes carry database/name separately so names
// containing dots (e.g. MV inner tables) stay unambiguous.
export function buildLineage(tables) {
  const key = (db, name) => `${db}.${name}`;
  const byId = new Map(tables.map(t => [key(t.database, t.name), t]));
  const nodes = new Map();
  const edges = new Map();
  const node = ([database, name]) => {
    const id = key(database, name);
    if (!nodes.has(id)) nodes.set(id, { id, database, name, engine: byId.get(id)?.engine || 'unknown' });
    return id;
  };
  const add = (from, to, kind) => {
    const a = node(from);
    const b = node(to);
    if (a !== b) edges.set(`${a}|${b}|${kind}`, { from: a, to: b, kind });
  };

  for (const t of tables) {
    const self = [t.database, t.name];
    t.dependencies_table.forEach((dep, i) => add(self, [t.dependencies_database[i], dep], 'materialized_view'));
    t.loading_dependent_table.forEach((dep, i) => {
      const consumer = [t.loading_dependent_database[i], dep];
      if (byId.get(key(...consumer))?.engine === 'Dictionary') add(self, consumer, 'dictionary');
    });

    if (t.engine === 'MaterializedView' || t.engine === 'View') {
      // Only keep references that resolve to a real table (drops e.g. EXTRACT(x FROM col))
      for (const src of selectSources(t.as_select || '', t.database)) {
        if (byId.has(key(...src))) add(src, self, t.engine === 'View' ? 'view' : 'materialized_view');
      }
    }
    if (t.engine === 'MaterializedView') {
      const to = t.create_table_query.match(/^CREATE MATERIALIZED VIEW\s+\S+\s+TO\s+(\S+)/i);
      if (to) {
        const parts = to[1].match(/`[^`]+`|[^.]+/g).map(unquote);
        add(self, parts.length === 2 ? parts : [t.database, parts[0]], 'mv_target');
      } else {
        const inner = tables.find(x => x.database === t.database && (x.name === `.inner_id.${t.uuid}` || x.name === `.inner.${t.name}`));
        if (inner) add(self, [inner.database, inner.name], 'mv_target');
      }
    }
    if (t.engine === 'Distributed') {
      const m = t.engine_full.match(/^Distributed\(\s*([^,]+),\s*([^,]+),\s*([^,)]+)/);
      if (m) {
        const db = unquote(m[2]);
        add([db === 'currentDatabase()' || !db ? t.database : db, unquote(m[3])], self, 'distributed');
      }
    }
    if (t.engine === 'Dictionary') {
      const src = t.create_table_query.match(/SOURCE\s*\(\s*CLICKHOUSE\s*\(([^)]*)\)/i);
      const table = src?.[1].match(/\bTABLE\s+'([^']+)'/i)?.[1];
      if (table) add([src[1].match(/\bDB\s+'([^']+)'/i)?.[1] || t.database, table], self, 'dictionary');
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// --- Usage ---------------------------------------------------------------------

function queryLogSource(ctx) {
  const cluster = ctx.getActiveEnvironment()?.cluster;
  return cluster ? `clusterAllReplicas(${quoteString(cluster)}, system.query_log)` : 'system.query_log';
}

async function queryLogAvailable(client) {
  const rows = await queryRows(client, `SELECT count() AS n FROM system.tables WHERE database = 'system' AND name = 'query_log'`);
  return Number(rows[0]?.n) > 0;
}

const USAGE_WHERE = `event_date >= today() - ${USAGE_DAYS} AND event_time >= now() - INTERVAL ${USAGE_DAYS} DAY
  AND type = 'QueryFinish' AND is_initial_query`;

export function register(app, ctx) {
  // Catalog of every table with documentation coverage.
  app.get('/api/dictionary/catalog', async (req, res) => {
    try {
      const rows = await queryRows(ctx.getClient(), `
        SELECT
          t.database AS database, t.name AS name, t.engine AS engine, t.comment AS comment,
          toUInt64(ifNull(t.total_rows, 0)) AS total_rows, toUInt64(ifNull(t.total_bytes, 0)) AS total_bytes,
          t.partition_key AS partition_key, t.sorting_key AS sorting_key, t.primary_key AS primary_key,
          t.sampling_key AS sampling_key,
          toString(t.metadata_modification_time) AS metadata_modification_time,
          toUInt32(ifNull(c.column_count, 0)) AS column_count,
          toUInt32(ifNull(c.documented_columns, 0)) AS documented_columns
        FROM system.tables t
        LEFT JOIN (
          SELECT database, table, count() AS column_count, countIf(comment != '') AS documented_columns
          FROM system.columns GROUP BY database, table
        ) c ON c.database = t.database AND c.table = t.name
        WHERE NOT t.is_temporary
        ORDER BY t.database, t.name
        SETTINGS output_format_json_quote_64bit_integers = 0`);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Save a table or column comment. Identifiers are validated against the
  // catalog first, then quoted; the comment is escaped as a string literal.
  app.post('/api/dictionary/comment', async (req, res) => {
    const { database, table, column, comment } = req.body || {};
    if (typeof database !== 'string' || typeof table !== 'string' || typeof comment !== 'string') {
      return res.status(400).json({ error: 'database, table and comment are required' });
    }
    if (column !== undefined && typeof column !== 'string') {
      return res.status(400).json({ error: 'column must be a string' });
    }
    if (SYSTEM_DATABASES.includes(database)) {
      return res.status(400).json({ error: 'System tables cannot be commented' });
    }
    try {
      const client = ctx.getClient();
      if (!(await findTable(client, database, table))) return res.status(404).json({ error: `Table ${database}.${table} not found` });
      if (column && !(await findColumn(client, database, table, column))) {
        return res.status(404).json({ error: `Column ${column} not found in ${database}.${table}` });
      }
      const target = `${quoteIdent(database)}.${quoteIdent(table)}`;
      const sql = column
        ? `ALTER TABLE ${target} COMMENT COLUMN ${quoteIdent(column)} ${quoteString(comment)}`
        : `ALTER TABLE ${target} MODIFY COMMENT ${quoteString(comment)}`;
      await client.command({ query: sql });
      res.json({ ok: true, sql });
    } catch (err) {
      // Typically ACCESS_DENIED when the user lacks ALTER permission
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Profile one column over a bounded sample of the table.
  app.get('/api/dictionary/profile', async (req, res) => {
    const { database, table, column } = req.query;
    if (typeof database !== 'string' || typeof table !== 'string' || typeof column !== 'string') {
      return res.status(400).json({ error: 'database, table and column are required' });
    }
    try {
      const client = ctx.getClient();
      const t = await findTable(client, database, table);
      if (!t) return res.status(404).json({ error: `Table ${database}.${table} not found` });
      const col = await findColumn(client, database, table, column);
      if (!col) return res.status(404).json({ error: `Column ${column} not found` });

      const target = `${quoteIdent(database)}.${quoteIdent(table)}`;
      const c = quoteIdent(column);
      const useSample = Boolean(t.sampling_key) && Number(t.total_rows) > PROFILE_SAMPLE_ROWS;
      const source = useSample
        ? `(SELECT ${c} AS v FROM ${target} SAMPLE ${PROFILE_SAMPLE_ROWS})`
        : `(SELECT ${c} AS v FROM ${target} LIMIT ${PROFILE_SAMPLE_ROWS})`;
      const orderable = isOrderable(col.type);
      const settings = 'SETTINGS output_format_json_quote_64bit_integers = 0, max_execution_time = 60';

      const [stats] = await queryRows(client, `
        SELECT count() AS sampled_rows, countIf(isNull(v)) AS null_count, uniq(v) AS distinct_count
          ${orderable ? ', toString(min(v)) AS min, toString(max(v)) AS max' : ''}
        FROM ${source} ${settings}`);
      const top = await queryRows(client, `
        SELECT toString(v) AS value, count() AS count FROM ${source}
        GROUP BY value ORDER BY count DESC, value LIMIT 10 ${settings}`);

      res.json({
        type: col.type,
        method: useSample ? `SAMPLE ${PROFILE_SAMPLE_ROWS}` : `LIMIT ${PROFILE_SAMPLE_ROWS}`,
        total_rows: Number(t.total_rows),
        sampled_rows: Number(stats.sampled_rows),
        null_count: Number(stats.null_count),
        distinct_count: Number(stats.distinct_count),
        min: orderable ? stats.min : null,
        max: orderable ? stats.max : null,
        top: top.map(r => ({ value: r.value, count: Number(r.count) })),
      });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Every lineage edge in the instance; the page walks it from the selected table.
  app.get('/api/dictionary/lineage', async (req, res) => {
    try {
      const tables = await queryRows(ctx.getClient(), `
        SELECT database, name, toString(uuid) AS uuid, engine, engine_full, create_table_query, as_select,
          dependencies_database, dependencies_table, loading_dependent_database, loading_dependent_table
        FROM system.tables
        WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`);
      res.json(buildLineage(tables));
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Per-table usage over the last 7 days, for the catalog grid.
  app.get('/api/dictionary/usage', async (req, res) => {
    try {
      const client = ctx.getClient();
      if (!(await queryLogAvailable(client))) return res.json({ available: false, tables: [] });
      const [window] = await queryRows(client, `
        SELECT toString(min(event_time)) AS oldest FROM ${queryLogSource(ctx)} WHERE event_date >= today() - ${USAGE_DAYS}`);
      const tables = await queryRows(client, `
        SELECT arrayJoin(tables) AS table, count() AS queries, uniqExact(user) AS users,
          toString(max(event_time)) AS last_queried
        FROM ${queryLogSource(ctx)}
        WHERE ${USAGE_WHERE}
        GROUP BY table
        SETTINGS output_format_json_quote_64bit_integers = 0`);
      res.json({ available: true, oldest: window?.oldest || null, days: USAGE_DAYS, tables });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });

  // Detailed usage for one table: users, query counts over time and the
  // columns it is read and filtered by. Optional start / end (unix seconds)
  // choose the window (default the last USAGE_DAYS days); grain = minute | hour
  // sets the resolution of `series`, which the UI groups into its buckets.
  app.get('/api/dictionary/usage/table', async (req, res) => {
    const { database, table } = req.query;
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    const windowed = Number.isFinite(start) && Number.isFinite(end) && end > start;
    const grain = req.query.grain === 'minute' ? 'Minute' : 'Hour';
    if (typeof database !== 'string' || typeof table !== 'string') {
      return res.status(400).json({ error: 'database and table are required' });
    }
    try {
      const client = ctx.getClient();
      if (!(await queryLogAvailable(client))) return res.json({ available: false });
      const params = { id: `${database}.${table}`, prefix: `${database}.${table}.`, start, end };
      const window = windowed
        ? `event_date >= toDate(fromUnixTimestamp({start:UInt32})) AND event_date <= toDate(fromUnixTimestamp({end:UInt32}))
           AND event_time >= fromUnixTimestamp({start:UInt32}) AND event_time <= fromUnixTimestamp({end:UInt32})
           AND type = 'QueryFinish' AND is_initial_query`
        : USAGE_WHERE;
      const where = `${window} AND has(tables, {id:String})`;
      const src = queryLogSource(ctx);
      const settings = 'SETTINGS output_format_json_quote_64bit_integers = 0';
      const [users, daily, kinds, columns, series, [overall]] = await Promise.all([
        queryRows(client, `
          SELECT user, count() AS queries, toString(max(event_time)) AS last_queried
          FROM ${src} WHERE ${where} GROUP BY user ORDER BY queries DESC LIMIT 10 ${settings}`, params),
        queryRows(client, `
          SELECT toString(event_date) AS day, count() AS queries
          FROM ${src} WHERE ${where} GROUP BY event_date ORDER BY event_date ${settings}`, params),
        queryRows(client, `
          SELECT query_kind AS kind, count() AS queries
          FROM ${src} WHERE ${where} GROUP BY kind ORDER BY queries DESC ${settings}`, params),
        // Read counts come from query_log.columns; "filtered" is approximated by
        // the column name appearing after WHERE/PREWHERE in the query text.
        queryRows(client, `
          SELECT substring(col, length({prefix:String}) + 1) AS column, count() AS reads,
            countIf(positionCaseInsensitive(
              substring(query, greatest(positionCaseInsensitive(query, 'WHERE'), 1)),
              substring(col, length({prefix:String}) + 1)) > 0 AND positionCaseInsensitive(query, 'WHERE') > 0) AS filtered
          FROM ${src} ARRAY JOIN columns AS col
          WHERE ${where} AND startsWith(col, {prefix:String})
          GROUP BY column ORDER BY filtered DESC, reads DESC LIMIT 20 ${settings}`, params),
        queryRows(client, `
          SELECT toUnixTimestamp(toStartOf${grain}(event_time)) AS t, count() AS queries
          FROM ${src} WHERE ${where} GROUP BY t ORDER BY t ${settings}`, params),
        queryRows(client, `
          SELECT count() AS queries, uniqExact(user) AS users, toString(max(event_time)) AS last_queried
          FROM ${src} WHERE ${where} ${settings}`, params),
      ]);
      res.json({ available: true, days: USAGE_DAYS, users, daily, kinds, columns, series, overall: overall || null });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    }
  });
}
