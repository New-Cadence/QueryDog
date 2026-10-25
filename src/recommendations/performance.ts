import { executeQuery } from '../services/api';
import type { Recommendation, RecommendationProvider, RecommendationSeverity } from './types';

// Performance recommendations derived from the last 24h of system.query_log
// (slow, scan-heavy, memory-heavy and failing query patterns, concurrency) and
// from the current state of system.parts / system.merges.

type Row = Record<string, unknown>;

// Shared with reliability.ts: run a SELECT and swallow any error (missing
// table, permissions, syntax differences between versions) as "no rows".
export async function queryRows(sql: string): Promise<Row[]> {
  try {
    return (await executeQuery(sql, 1000)).data;
  } catch {
    return [];
  }
}

export async function systemTables(): Promise<Set<string>> {
  const rows = await queryRows("SELECT name FROM system.tables WHERE database = 'system' LIMIT 2000");
  return new Set(rows.map(r => String(r.name)));
}

export const num = (v: unknown) => Number(v) || 0;
export const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
export const sqlString = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const fmtBytes = (b: number) =>
  b >= GiB ? `${(b / GiB).toFixed(1)} GiB` : b >= MiB ? `${(b / MiB).toFixed(0)} MiB` : `${(b / 1024).toFixed(0)} KiB`;
const fmtMs = (ms: number) =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const fmtCount = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
const truncate = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n)}...` : s);

// Every query_log check looks at user queries from the last 24 hours. Queries
// touching only system tables (including Convoy's own) are ignored.
const QUERY_LOG = 'system.query_log';
const WINDOW = `event_date >= toDate(now() - INTERVAL 1 DAY) AND event_time >= now() - INTERVAL 1 DAY
    AND NOT arrayAll(d -> lower(d) IN ('system', 'information_schema'), databases)`;

interface TableInfo {
  sortingKey: string;
  totalRows: number;
}

async function tableInfo(names: string[]): Promise<Map<string, TableInfo>> {
  const out = new Map<string, TableInfo>();
  if (!names.length) return out;
  const rows = await queryRows(`
    SELECT concat(database, '.', name) AS t, sorting_key, total_rows
    FROM system.tables
    WHERE concat(database, '.', name) IN (${names.map(sqlString).join(', ')})
    LIMIT 200`);
  for (const r of rows) out.set(str(r.t), { sortingKey: str(r.sorting_key), totalRows: num(r.total_rows) });
  return out;
}

// Pick a column the query reads that is not part of the sorting key: the most
// likely filter column that the primary index cannot help with.
function candidateColumn(table: string, columns: string[], sortingKey: string): string | undefined {
  const keyCols = new Set(sortingKey.split(',').map(c => c.trim()));
  return columns
    .filter(c => c.startsWith(`${table}.`))
    .map(c => c.slice(table.length + 1))
    .find(c => !keyCols.has(c) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
}

async function queryPatternChecks(): Promise<Recommendation[]> {
  const [patterns, limits] = await Promise.all([
    queryRows(`
      SELECT
        toString(normalized_query_hash) AS hash,
        any(query) AS sample,
        count() AS runs,
        quantile(0.95)(query_duration_ms) AS p95_ms,
        sum(query_duration_ms) AS total_ms,
        sum(read_rows) AS read_rows,
        sum(result_rows) AS result_rows,
        quantile(0.95)(memory_usage) AS p95_memory,
        any(arrayFilter(t -> NOT startsWith(t, 'system.'), tables)[1]) AS main_table,
        groupUniqArrayArray(50)(columns) AS columns
      FROM ${QUERY_LOG}
      WHERE ${WINDOW} AND type = 'QueryFinish' AND query_kind = 'Select' AND is_initial_query
      GROUP BY normalized_query_hash
      HAVING p95_ms >= 1000 OR p95_memory >= ${GiB} OR (read_rows >= 10000000 AND read_rows >= 1000 * greatest(result_rows, 1))
      ORDER BY total_ms DESC
      LIMIT 50`),
    queryRows("SELECT toUInt64(value) AS v FROM system.server_settings WHERE name = 'max_server_memory_usage' LIMIT 1"),
  ]);
  if (!patterns.length) return [];

  const tables = await tableInfo([...new Set(patterns.map(p => str(p.main_table)).filter(Boolean))]);
  const serverMemory = num(limits[0]?.v);
  const recs: Recommendation[] = [];

  for (const p of patterns) {
    const hash = str(p.hash);
    const sample = truncate(str(p.sample).trim());
    const runs = num(p.runs);
    const p95 = num(p.p95_ms);
    const readRows = num(p.read_rows);
    const resultRows = num(p.result_rows);
    const p95Memory = num(p.p95_memory);
    const table = str(p.main_table);
    const info = tables.get(table);
    const target = table ? `${table} (query ${hash})` : `query ${hash}`;
    const explain = `-- Check which indexes and granules the query uses:\nEXPLAIN indexes = 1\n${sample}`;

    if (p95 >= 1000) {
      const severity: RecommendationSeverity = p95 >= 10000 ? 'high' : p95 >= 3000 ? 'medium' : 'low';
      recs.push({
        id: `performance:slow-pattern:${hash}`,
        category: 'performance',
        severity,
        title: `Slow query pattern (p95 ${fmtMs(p95)})`,
        detail: `This normalized query ran ${runs.toLocaleString()} times in the last 24h with a p95 latency of ${fmtMs(p95)} ` +
          `and ${fmtMs(num(p.total_ms))} of total execution time.\n\nSample:\n${sample}`,
        target,
        impact: `${fmtMs(num(p.total_ms))} of query time per day`,
        remediation: explain + (info ? `;\n\n-- Table ${table} is ordered by (${info.sortingKey || 'tuple()'}). Filters should use a prefix of that key.` : ''),
      });
    }

    const avgRead = readRows / Math.max(runs, 1);
    if (readRows >= 10_000_000 && readRows >= 1000 * Math.max(resultRows, 1) && table) {
      const fullScan = !!info && info.totalRows > 0 && avgRead >= 0.5 * info.totalRows;
      const column = info ? candidateColumn(table, (p.columns as string[]) || [], info.sortingKey) : undefined;
      const fix = column
        ? `\n\n-- If the WHERE clause filters on ${column} (outside the sorting key), add a skipping index:\n` +
          `ALTER TABLE ${table} ADD INDEX idx_${column} ${column} TYPE bloom_filter GRANULARITY 4;\n` +
          `ALTER TABLE ${table} MATERIALIZE INDEX idx_${column};\n\n` +
          `-- Or, for range filters / frequent lookups, a projection ordered by it:\n` +
          `ALTER TABLE ${table} ADD PROJECTION p_by_${column} (SELECT * ORDER BY ${column});\n` +
          `ALTER TABLE ${table} MATERIALIZE PROJECTION p_by_${column};`
        : '';
      recs.push({
        id: `performance:scan-heavy:${hash}`,
        category: 'performance',
        severity: fullScan && avgRead >= 100_000_000 ? 'high' : fullScan ? 'medium' : 'low',
        title: fullScan ? `Full scan of ${table}` : `Query reads far more rows than it returns`,
        detail: `Each run reads ~${fmtCount(avgRead)} rows on average` +
          (info?.totalRows ? ` of ${fmtCount(info.totalRows)} in ${table}` : '') +
          ` but the pattern returned ${fmtCount(resultRows)} rows in total over ${runs.toLocaleString()} runs ` +
          `(${fmtCount(readRows / Math.max(resultRows, 1))} rows read per row returned). ` +
          `Unless this is an intentional aggregation over the whole table, the primary key is not narrowing the read.\n\nSample:\n${sample}`,
        target,
        impact: `${fmtCount(readRows)} rows read per day`,
        remediation: explain + ';' + fix,
      });
    }

    const memoryShare = serverMemory ? p95Memory / serverMemory : 0;
    if (p95Memory >= GiB) {
      recs.push({
        id: `performance:memory-heavy:${hash}`,
        category: 'performance',
        severity: memoryShare >= 0.3 ? 'high' : p95Memory >= 4 * GiB ? 'medium' : 'low',
        title: `Memory-heavy query (p95 ${fmtBytes(p95Memory)})`,
        detail: `p95 memory usage is ${fmtBytes(p95Memory)}` +
          (serverMemory ? ` (${(memoryShare * 100).toFixed(0)}% of the ${fmtBytes(serverMemory)} server limit)` : '') +
          `. Large GROUP BY / JOIN / ORDER BY states risk MEMORY_LIMIT_EXCEEDED for this and concurrent queries.\n\nSample:\n${sample}`,
        target,
        impact: `${fmtBytes(p95Memory)} per run`,
        remediation:
          `-- Let large aggregations, sorts and joins spill to disk instead of failing:\n` +
          `SET max_bytes_before_external_group_by = 2147483648, max_bytes_before_external_sort = 2147483648;\n` +
          `SET join_algorithm = 'grace_hash';\n` +
          `-- Then re-run and compare memory_usage in system.query_log:\n${sample}`,
      });
    }
  }
  return recs;
}

// Advice keyed by the ClickHouse error name of the failing pattern.
const FAILURE_ADVICE: Record<string, string> = {
  MEMORY_LIMIT_EXCEEDED: "SET max_bytes_before_external_group_by = 2147483648, max_bytes_before_external_sort = 2147483648, join_algorithm = 'grace_hash';",
  TIMEOUT_EXCEEDED: '-- Narrow the query with primary key filters, or raise max_execution_time for this workload:\nSET max_execution_time = 300;',
  TOO_MANY_SIMULTANEOUS_QUERIES: '-- Spread the load or raise the limit (server setting max_concurrent_queries).',
  TOO_MANY_ROWS_OR_BYTES: '-- The query hits max_rows_to_read / max_result_rows: add filters or LIMIT.',
  QUERY_WAS_CANCELLED: '-- Queries are being cancelled (client timeouts or KILL QUERY): check client timeouts.',
};

async function failingQueryChecks(): Promise<Recommendation[]> {
  const rows = await queryRows(`
    SELECT
      toString(normalized_query_hash) AS hash,
      errorCodeToName(exception_code) AS error,
      count() AS failures,
      any(query) AS sample,
      any(exception) AS message,
      any(arrayFilter(t -> NOT startsWith(t, 'system.'), tables)[1]) AS main_table
    FROM ${QUERY_LOG}
    WHERE ${WINDOW} AND type IN ('ExceptionBeforeStart', 'ExceptionWhileProcessing')
    GROUP BY normalized_query_hash, exception_code
    HAVING failures >= 10
    ORDER BY failures DESC
    LIMIT 20`);
  return rows.map(r => {
    const failures = num(r.failures);
    const error = str(r.error);
    return {
      id: `performance:failing-pattern:${str(r.hash)}:${error}`,
      category: 'performance' as const,
      severity: failures >= 1000 ? 'high' : failures >= 100 ? 'medium' : 'low',
      title: `Query pattern failing repeatedly with ${error}`,
      detail: `${failures.toLocaleString()} failures in the last 24h.\n\nLast error: ${truncate(str(r.message), 600)}\n\nSample:\n${truncate(str(r.sample))}`,
      target: str(r.main_table) ? `${str(r.main_table)} (query ${str(r.hash)})` : `query ${str(r.hash)}`,
      impact: `${failures.toLocaleString()} failed queries per day`,
      remediation: FAILURE_ADVICE[error] || '-- Inspect the failures:\n' +
        `SELECT event_time, user, exception FROM system.query_log\nWHERE normalized_query_hash = ${str(r.hash)} AND exception_code != 0\nORDER BY event_time DESC LIMIT 20`,
    };
  });
}

async function concurrencyCheck(): Promise<Recommendation[]> {
  const [peak, limit] = await Promise.all([
    queryRows(`
      SELECT toString(toStartOfMinute(event_time)) AS minute, sum(query_duration_ms) / 60000 AS avg_concurrency, count() AS queries
      FROM ${QUERY_LOG}
      WHERE ${WINDOW} AND type IN ('QueryFinish', 'ExceptionWhileProcessing')
      GROUP BY minute
      ORDER BY avg_concurrency DESC
      LIMIT 1`),
    queryRows("SELECT toUInt64(value) AS v FROM system.server_settings WHERE name = 'max_concurrent_queries' LIMIT 1"),
  ]);
  if (!peak.length) return [];
  const concurrency = num(peak[0].avg_concurrency);
  const max = num(limit[0]?.v);
  const share = max ? concurrency / max : 0;
  if (concurrency < 16 && share < 0.5) return [];
  return [{
    id: 'performance:high-concurrency',
    category: 'performance',
    severity: share >= 0.8 ? 'high' : 'medium',
    title: `High query concurrency (peak ~${concurrency.toFixed(0)} concurrent queries)`,
    detail: `During the busiest minute (${str(peak[0].minute)}) an average of ${concurrency.toFixed(1)} queries were running at once ` +
      `(${num(peak[0].queries).toLocaleString()} queries finished in that minute)` +
      (max ? `; max_concurrent_queries is ${max}.` : '.') +
      ' Heavy concurrency makes queries compete for CPU and memory and raises tail latency.',
    target: 'server',
    impact: max ? `${(share * 100).toFixed(0)}% of max_concurrent_queries at peak` : `~${concurrency.toFixed(0)} concurrent queries at peak`,
    remediation:
      '-- Find which users drive the peak:\n' +
      `SELECT user, count() AS queries, sum(query_duration_ms) / 60000 AS busy_minutes\nFROM system.query_log\nWHERE event_time >= now() - INTERVAL 1 DAY AND type = 'QueryFinish'\nGROUP BY user ORDER BY busy_minutes DESC LIMIT 10;\n\n` +
      '-- Then cap noisy workloads, e.g. with a settings profile / workload:\n' +
      "-- ALTER USER <user> SETTINGS max_threads = 4, max_concurrent_queries_for_user = 10;",
  }];
}

async function partsChecks(): Promise<Recommendation[]> {
  const [partitions, tables, merges] = await Promise.all([
    queryRows(`
      SELECT database, table, partition_id, count() AS parts
      FROM system.parts
      WHERE active AND database != 'system'
      GROUP BY database, table, partition_id
      HAVING parts >= 300
      ORDER BY parts DESC
      LIMIT 20`),
    queryRows(`
      SELECT database, table, count() AS parts, sum(bytes_on_disk) AS bytes, uniqExact(partition_id) AS partitions,
        countIf(level = 0 AND modification_time < now() - INTERVAL 1 HOUR) AS stale_unmerged
      FROM system.parts
      WHERE active AND database != 'system'
      GROUP BY database, table
      HAVING (parts >= 50 AND bytes / parts < ${MiB}) OR partitions >= 1000 OR stale_unmerged >= 50
      ORDER BY parts DESC
      LIMIT 30`),
    queryRows(`
      SELECT database, table, result_part_name, elapsed, progress, num_parts, is_mutation, total_size_bytes_compressed AS bytes
      FROM system.merges
      WHERE elapsed >= 3600
      ORDER BY elapsed DESC
      LIMIT 10`),
  ]);
  const recs: Recommendation[] = [];

  for (const p of partitions) {
    const table = `${str(p.database)}.${str(p.table)}`;
    const parts = num(p.parts);
    const partition = str(p.partition_id);
    recs.push({
      id: `performance:parts-per-partition:${table}:${partition}`,
      category: 'performance',
      severity: parts >= 1000 ? 'high' : 'medium',
      title: `${parts.toLocaleString()} active parts in one partition`,
      detail: `Partition ${partition} of ${table} has ${parts.toLocaleString()} active parts. Inserts are delayed at ` +
        'parts_to_delay_insert and rejected with TOO_MANY_PARTS at parts_to_throw_insert, and every SELECT has to open each part.',
      target: `${table} partition ${partition}`,
      impact: 'Risk of TOO_MANY_PARTS insert failures',
      remediation: `-- Batch inserts (10k-1M rows per insert) or let the server batch them:\nALTER USER <insert_user> SETTINGS async_insert = 1, wait_for_async_insert = 1;\n\n` +
        `-- Merge the partition now (heavy: runs a full merge):\nOPTIMIZE TABLE ${table} PARTITION ID ${sqlString(partition)} FINAL;`,
    });
  }

  for (const t of tables) {
    const table = `${str(t.database)}.${str(t.table)}`;
    const parts = num(t.parts);
    const bytes = num(t.bytes);
    const partitionsCount = num(t.partitions);
    const stale = num(t.stale_unmerged);
    if (parts >= 50 && bytes / parts < MiB) {
      recs.push({
        id: `performance:small-parts:${table}`,
        category: 'performance',
        severity: parts >= 500 ? 'high' : 'medium',
        title: `Many small parts in ${table}`,
        detail: `${table} has ${parts.toLocaleString()} active parts averaging ${(bytes / parts / 1024).toFixed(1)} KiB. ` +
          'This usually means frequent small inserts: each insert creates a part, adding merge load and slowing reads.',
        target: table,
        impact: `${parts.toLocaleString()} parts to open per full read`,
        remediation: `-- Buffer small inserts server-side:\nALTER USER <insert_user> SETTINGS async_insert = 1, wait_for_async_insert = 1, async_insert_busy_timeout_ms = 1000;\n\n` +
          `-- Compact the existing parts:\nOPTIMIZE TABLE ${table} FINAL;`,
      });
    }
    if (partitionsCount >= 1000) {
      recs.push({
        id: `performance:over-partitioned:${table}`,
        category: 'performance',
        severity: 'medium',
        title: `${table} has ${partitionsCount.toLocaleString()} partitions`,
        detail: 'Parts are never merged across partitions, so a fine-grained PARTITION BY (e.g. by day or by id) keeps the part count high. ' +
          'Partitions should usually be monthly or coarser, with fewer than ~1000 in total.',
        target: table,
        impact: 'Higher part count, slower merges and queries',
        remediation: `-- Inspect the current key:\nSELECT partition_key, sorting_key FROM system.tables WHERE database = ${sqlString(str(t.database))} AND name = ${sqlString(str(t.table))};\n\n` +
          `-- Recreate with a coarser key, e.g. PARTITION BY toYYYYMM(<date_column>), then INSERT ... SELECT and EXCHANGE TABLES.`,
      });
    }
    if (stale >= 50) {
      recs.push({
        id: `performance:merges-behind:${table}`,
        category: 'performance',
        severity: stale >= 300 ? 'high' : 'medium',
        title: `Merges falling behind on ${table}`,
        detail: `${stale.toLocaleString()} freshly inserted (level 0) parts of ${table} are older than an hour and still unmerged. ` +
          'Either merges are stopped or the merge pool cannot keep up with the insert rate.',
        target: table,
        impact: 'Part count growing towards TOO_MANY_PARTS',
        remediation: `-- Make sure merges are not stopped for this table:\nSYSTEM START MERGES ${table};\n\n` +
          `-- Check merge pool saturation:\nSELECT metric, value FROM system.metrics WHERE metric IN ('BackgroundMergesAndMutationsPoolTask', 'BackgroundMergesAndMutationsPoolSize');`,
      });
    }
  }

  for (const m of merges) {
    const table = `${str(m.database)}.${str(m.table)}`;
    recs.push({
      id: `performance:long-merge:${table}:${str(m.result_part_name)}`,
      category: 'performance',
      severity: 'medium',
      title: `Long-running ${num(m.is_mutation) ? 'mutation' : 'merge'} on ${table}`,
      detail: `A ${num(m.is_mutation) ? 'mutation' : 'merge'} of ${num(m.num_parts)} parts (${fmtBytes(num(m.bytes))}) has been running for ` +
        `${(num(m.elapsed) / 3600).toFixed(1)}h and is ${(num(m.progress) * 100).toFixed(0)}% complete.`,
      target: table,
      impact: 'Holds a background pool slot and disk space for the duration',
      remediation: `SELECT * FROM system.merges WHERE database = ${sqlString(str(m.database))} AND table = ${sqlString(str(m.table))};`,
    });
  }
  return recs;
}

export const performanceProvider: RecommendationProvider = {
  category: 'performance',
  label: 'Performance',
  run: async () => {
    const tables = await systemTables();
    const checks = [partsChecks()];
    if (tables.has('query_log')) checks.push(queryPatternChecks(), failingQueryChecks(), concurrencyCheck());
    const results = await Promise.all(checks.map(c => c.catch(() => [])));
    return results.flat();
  },
};
