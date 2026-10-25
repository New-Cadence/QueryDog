// Starter notebooks offered by "New notebook". Every query reads standard
// system tables; query_log / part_log based cells need those logs enabled.
import { uid, type Notebook, type NotebookCell, type OutputView, type ParamKind } from './model';

export interface NotebookTemplate {
  id: string;
  title: string;
  description: string;
  cells: () => NotebookCell[];
}

const md = (name: string, source: string): NotebookCell => ({ id: uid(), type: 'markdown', name, source, view: 'table' });

const sql = (name: string, source: string, view: OutputView = 'table', xKey?: string, yKeys?: string[]): NotebookCell =>
  ({ id: uid(), type: 'sql', name, source, view, xKey, yKeys });

const param = (name: string, paramKind: ParamKind, value: string, extra: Partial<NotebookCell> = {}): NotebookCell =>
  ({ id: uid(), type: 'param', name, source: value, view: 'table', paramKind, ...extra });

const USER_DATABASES = "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

export const TEMPLATES: NotebookTemplate[] = [
  {
    id: 'cluster-health',
    title: 'Cluster health',
    description: 'Server overview, live metrics, query volume and failures, part hotspots, recent errors and replication.',
    cells: () => [
      md('intro', '# Cluster health\n\nA quick health check of the connected server. Change **hours** and press Enter to re-run every cell that uses it.'),
      param('hours', 'number', '24'),
      sql('overview', `SELECT
  hostName() AS host,
  version() AS version,
  formatReadableTimeDelta(uptime()) AS uptime,
  (SELECT count() FROM system.databases) AS databases,
  (SELECT count() FROM system.tables WHERE ${USER_DATABASES}) AS user_tables,
  (SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active) AS data_on_disk`),
      sql('live_metrics', `SELECT metric, value, description
FROM system.metrics
WHERE metric IN ('Query', 'Merge', 'PartMutation', 'TCPConnection', 'HTTPConnection',
                 'MemoryTracking', 'BackgroundMergesAndMutationsPoolTask', 'DelayedInserts')
ORDER BY metric`),
      md('volume', '## Query volume\n\nFinished vs failed queries per hour, from `system.query_log`.'),
      sql('queries_per_hour', `SELECT
  toStartOfHour(event_time) AS hour,
  countIf(type = 'QueryFinish') AS finished,
  countIf(type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')) AS failed
FROM system.query_log
WHERE event_time > now() - INTERVAL {{hours}} HOUR AND type != 'QueryStart'
GROUP BY hour
ORDER BY hour`, 'bar', 'hour', ['finished', 'failed']),
      md('parts', '## Part hotspots\n\nPartitions with many active parts merge slowly and can trigger *Too many parts* errors.'),
      sql('parts_per_partition', `SELECT database, table, partition, count() AS parts, sum(rows) AS rows
FROM system.parts
WHERE active
GROUP BY database, table, partition
ORDER BY parts DESC
LIMIT 10`),
      sql('recent_errors', `SELECT name, code, value AS occurrences, last_error_time, last_error_message
FROM system.errors
WHERE last_error_time > now() - INTERVAL {{hours}} HOUR
ORDER BY last_error_time DESC
LIMIT 20`),
      sql('replication', `SELECT database, table, is_readonly, is_session_expired, absolute_delay, queue_size, inserts_in_queue, merges_in_queue
FROM system.replicas
ORDER BY absolute_delay DESC`),
    ],
  },
  {
    id: 'slow-queries',
    title: 'Slow query investigation',
    description: 'Slowest queries, recurring slow patterns, latency percentiles over time and the heaviest memory users.',
    cells: () => [
      md('intro', '# Slow query investigation\n\nNarrow the window and threshold with the parameters, then drill into the patterns that cost the most in total.'),
      param('hours', 'number', '24'),
      param('min_duration_ms', 'number', '100'),
      param('query_kind', 'dropdown', 'All', { options: ['All', 'Select', 'Insert', 'Create', 'System', 'Alter'] }),
      sql('slow_queries', `SELECT
  event_time,
  user,
  query_kind,
  query_duration_ms,
  read_rows,
  read_bytes,
  memory_usage,
  normalized_query_hash,
  substring(query, 1, 300) AS query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL {{hours}} HOUR
  AND query_duration_ms >= {{min_duration_ms}}
  AND ({{query_kind}} = 'All' OR query_kind = {{query_kind}})
ORDER BY query_duration_ms DESC
LIMIT 100`),
      sql('by_user', `SELECT user, count() AS slow_queries, max(query_duration_ms) AS max_ms
FROM {{slow_queries}}
GROUP BY user
ORDER BY slow_queries DESC`, 'bar', 'user', ['slow_queries']),
      md('patterns', '## Recurring patterns\n\nQueries grouped by `normalized_query_hash`, ranked by total time spent.'),
      sql('patterns_by_total_time', `SELECT
  normalized_query_hash,
  count() AS runs,
  round(avg(query_duration_ms)) AS avg_ms,
  max(query_duration_ms) AS max_ms,
  sum(query_duration_ms) AS total_ms,
  sum(read_rows) AS rows_read,
  any(substring(normalizeQuery(query), 1, 300)) AS pattern
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL {{hours}} HOUR
  AND ({{query_kind}} = 'All' OR query_kind = {{query_kind}})
GROUP BY normalized_query_hash
ORDER BY total_ms DESC
LIMIT 25`),
      sql('latency_percentiles', `SELECT
  toStartOfHour(event_time) AS hour,
  round(quantile(0.5)(query_duration_ms)) AS p50_ms,
  round(quantile(0.95)(query_duration_ms)) AS p95_ms,
  round(quantile(0.99)(query_duration_ms)) AS p99_ms
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL {{hours}} HOUR
  AND ({{query_kind}} = 'All' OR query_kind = {{query_kind}})
GROUP BY hour
ORDER BY hour`, 'line', 'hour', ['p50_ms', 'p95_ms', 'p99_ms']),
      sql('top_memory', `SELECT event_time, user, formatReadableSize(memory_usage) AS memory, query_duration_ms, substring(query, 1, 300) AS query
FROM system.query_log
WHERE type = 'QueryFinish' AND event_time > now() - INTERVAL {{hours}} HOUR
ORDER BY memory_usage DESC
LIMIT 20`),
      sql('failed_queries', `SELECT event_time, user, exception_code, substring(exception, 1, 300) AS exception, substring(query, 1, 200) AS query
FROM system.query_log
WHERE type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')
  AND event_time > now() - INTERVAL {{hours}} HOUR
ORDER BY event_time DESC
LIMIT 50`),
    ],
  },
  {
    id: 'storage',
    title: 'Storage & compression analysis',
    description: 'Disk usage, size by database, per-table compression ratios, the least compressible columns and part formats.',
    cells: () => [
      md('intro', '# Storage & compression\n\nWhere the bytes go and how well they compress. Ratios are uncompressed ÷ compressed.'),
      sql('disks', `SELECT name, path, type,
  formatReadableSize(total_space) AS total,
  formatReadableSize(free_space) AS free,
  round(100 * (1 - free_space / nullIf(total_space, 0)), 1) AS used_pct
FROM system.disks`),
      sql('by_database', `SELECT database, round(sum(bytes_on_disk) / 1e6, 2) AS mb_on_disk, sum(rows) AS rows, count() AS parts
FROM system.parts
WHERE active
GROUP BY database
ORDER BY mb_on_disk DESC`, 'bar', 'database', ['mb_on_disk']),
      sql('table_compression', `SELECT
  database,
  table,
  sum(rows) AS rows,
  formatReadableSize(sum(data_compressed_bytes)) AS compressed,
  formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
  round(sum(data_uncompressed_bytes) / nullIf(sum(data_compressed_bytes), 0), 2) AS ratio,
  count() AS parts
FROM system.parts
WHERE active
GROUP BY database, table
ORDER BY sum(data_compressed_bytes) DESC
LIMIT 25`),
      md('columns', '## Columns\n\nLarge columns with a low ratio are candidates for a better codec (`ZSTD`, `Delta`, `LowCardinality`, ...).'),
      sql('column_compression', `SELECT
  database,
  table,
  name AS column,
  type,
  compression_codec,
  formatReadableSize(data_compressed_bytes) AS compressed,
  round(data_uncompressed_bytes / nullIf(data_compressed_bytes, 0), 2) AS ratio
FROM system.columns
WHERE ${USER_DATABASES} AND data_compressed_bytes > 0
ORDER BY data_compressed_bytes DESC
LIMIT 25`),
      sql('part_types', `SELECT part_type, count() AS parts, sum(rows) AS rows, formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE active
GROUP BY part_type`),
    ],
  },
  {
    id: 'table-deep-dive',
    title: 'Table deep dive',
    description: 'Pick a table to see its schema, keys, column sizes, partitions, pending mutations and recent queries.',
    cells: () => [
      md('intro', '# Table deep dive\n\nChoose a table from the dropdown; every cell below re-runs for it.'),
      param('table_name', 'dropdown', 'analytics.events', {
        options: ['analytics.events'],
        optionsSql: `SELECT concat(database, '.', name) FROM system.tables WHERE ${USER_DATABASES} AND NOT is_temporary ORDER BY 1`,
      }),
      sql('overview', `SELECT engine, total_rows, formatReadableSize(total_bytes) AS size, partition_key, sorting_key, primary_key, metadata_modification_time
FROM system.tables
WHERE concat(database, '.', name) = {{table_name}}`),
      sql('create_statement', `SELECT create_table_query
FROM system.tables
WHERE concat(database, '.', name) = {{table_name}}`),
      sql('columns', `SELECT
  name,
  type,
  is_in_primary_key,
  compression_codec,
  formatReadableSize(data_compressed_bytes) AS compressed,
  formatReadableSize(data_uncompressed_bytes) AS uncompressed,
  round(data_uncompressed_bytes / nullIf(data_compressed_bytes, 0), 2) AS ratio
FROM system.columns
WHERE concat(database, '.', table) = {{table_name}}
ORDER BY position`),
      sql('partitions', `SELECT partition, count() AS parts, sum(rows) AS rows, round(sum(bytes_on_disk) / 1e6, 2) AS mb, max(modification_time) AS last_modified
FROM system.parts
WHERE active AND concat(database, '.', table) = {{table_name}}
GROUP BY partition
ORDER BY partition`, 'bar', 'partition', ['mb']),
      sql('mutations', `SELECT mutation_id, command, create_time, is_done, parts_to_do, latest_fail_reason
FROM system.mutations
WHERE concat(database, '.', table) = {{table_name}}
ORDER BY create_time DESC
LIMIT 20`),
      sql('recent_queries', `SELECT event_time, user, query_kind, query_duration_ms, read_rows, substring(query, 1, 300) AS query
FROM system.query_log
WHERE type = 'QueryFinish' AND has(tables, {{table_name}}) AND event_time > now() - INTERVAL 1 DAY
ORDER BY event_time DESC
LIMIT 50`),
    ],
  },
  {
    id: 'insert-throughput',
    title: 'Insert throughput',
    description: 'Rows and bytes written over time, the busiest insert targets, new part creation, async inserts and merge backlog.',
    cells: () => [
      md('intro', '# Insert throughput\n\nHow fast data is arriving and whether merges are keeping up. Many small inserts show up as lots of new parts.'),
      param('hours', 'number', '24'),
      sql('rows_written_per_hour', `SELECT
  toStartOfHour(event_time) AS hour,
  count() AS inserts,
  sum(written_rows) AS rows_written,
  round(sum(written_bytes) / 1e6, 2) AS mb_written
FROM system.query_log
WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND event_time > now() - INTERVAL {{hours}} HOUR
GROUP BY hour
ORDER BY hour`, 'area', 'hour', ['rows_written']),
      sql('top_insert_targets', `SELECT
  arrayJoin(tables) AS target,
  count() AS inserts,
  sum(written_rows) AS rows_written,
  round(avg(written_rows)) AS avg_rows_per_insert,
  round(avg(query_duration_ms)) AS avg_ms
FROM system.query_log
WHERE type = 'QueryFinish' AND query_kind = 'Insert' AND event_time > now() - INTERVAL {{hours}} HOUR
GROUP BY target
ORDER BY rows_written DESC
LIMIT 20`),
      md('parts', '## Part creation\n\nFrom `system.part_log`. A high new-part rate with few rows per part means inserts should be batched (or use async inserts).'),
      sql('new_parts', `SELECT
  concat(database, '.', table) AS target,
  count() AS new_parts,
  sum(rows) AS rows_written,
  round(avg(rows)) AS rows_per_part
FROM system.part_log
WHERE event_type = 'NewPart' AND event_time > now() - INTERVAL {{hours}} HOUR
GROUP BY target
ORDER BY new_parts DESC
LIMIT 20`),
      sql('async_inserts', `SELECT concat(database, '.', table) AS target, status, count() AS inserts, sum(rows) AS rows
FROM system.asynchronous_insert_log
WHERE event_time > now() - INTERVAL {{hours}} HOUR
GROUP BY target, status
ORDER BY inserts DESC`),
      sql('merges_in_progress', `SELECT database, table, round(elapsed, 1) AS elapsed_s, round(progress * 100, 1) AS progress_pct, num_parts, formatReadableSize(total_size_bytes_compressed) AS size, merge_type
FROM system.merges
ORDER BY elapsed DESC`),
    ],
  },
];

export function notebookFromTemplate(template: NotebookTemplate | null): Notebook {
  const cells = template
    ? template.cells()
    : [md('text_1', '# Untitled notebook\n\nDescribe what this notebook investigates.'), sql('query_1', 'SELECT 1')];
  return { id: uid(), title: template?.title || 'Untitled notebook', updatedAt: new Date().toISOString(), template: template?.id, cells };
}

// Seeded on first run when the server has no notebooks.
export function sampleNotebook(): Notebook {
  return {
    id: uid(),
    title: 'Getting started',
    updatedAt: new Date().toISOString(),
    cells: [
      md('intro', '# Getting started\n\nRun a cell with **Shift+Enter**, or everything with **Run all**.\n\n- SQL cells can reference earlier cells with `{{cell_name}}`, which inlines them as a subquery.\n- Parameter cells are substituted as SQL literals, e.g. `{{min_rows}}`.\n- Switch an output between table and chart views, export it as CSV, or open **Stats** and **Explain**.'),
      param('min_rows', 'number', '0'),
      sql('largest_tables', `SELECT
  concat(database, '.', table) AS table,
  round(sum(bytes_on_disk) / 1e6, 2) AS mb,
  sum(rows) AS rows
FROM system.parts
WHERE active
GROUP BY table
HAVING rows >= {{min_rows}}
ORDER BY mb DESC
LIMIT 10`, 'bar', 'table', ['mb']),
      sql('top_three', 'SELECT *\nFROM {{largest_tables}}\nORDER BY rows DESC\nLIMIT 3'),
    ],
  };
}
