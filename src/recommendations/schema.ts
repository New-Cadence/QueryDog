import { executeQuery } from '../services/api';
import type { Recommendation, RecommendationProvider, RecommendationSeverity } from './types';

// Schema design issues found from system.tables / system.columns, plus a sampled scan of Nullable and String columns.

const ident = (s: string) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';

async function safeRows<T>(sql: string): Promise<T[]> {
  try {
    return (await executeQuery(sql, 100000)).data as T[];
  } catch {
    return [];
  }
}

const GiB = 1024 ** 3;
const SAMPLE_ROWS = 1_000_000;
const MAX_SCANNED_TABLES = 25;
const LOW_CARDINALITY_MAX_DISTINCT = 10_000;
const UNPARTITIONED_BYTES = 10 * GiB;
const WIDE_ORDER_BY = 5;

interface TableRow {
  database: string;
  name: string;
  engine: string;
  total_rows: number;
  total_bytes: number;
  partition_key: string;
  sorting_key: string;
}

interface ColumnRow {
  database: string;
  table: string;
  name: string;
  type: string;
}

const user = `database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')`;

// Split "a, f(b, c), d" on top-level commas only.
function splitTopLevel(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

const bySize = (bytes: number): RecommendationSeverity => (bytes > 100 * GiB ? 'high' : bytes > GiB ? 'medium' : 'low');

// One sampled query per table: NULL counts for Nullable columns and distinct
// counts for plain String columns.
async function columnChecks(tables: TableRow[], columns: ColumnRow[]): Promise<Recommendation[]> {
  const recs: Recommendation[] = [];
  const largest = [...tables].sort((a, b) => b.total_bytes - a.total_bytes).slice(0, MAX_SCANNED_TABLES);
  await Promise.all(largest.map(async t => {
    const id = `${t.database}.${t.name}`;
    const cols = columns.filter(c => c.database === t.database && c.table === t.name);
    const nullable = cols.filter(c => c.type.startsWith('Nullable('));
    const strings = cols.filter(c => c.type === 'String' || c.type === 'Nullable(String)');
    if (!nullable.length && !strings.length) return;

    const target = `${ident(t.database)}.${ident(t.name)}`;
    const exprs = [
      'count() AS n',
      ...nullable.map((c, i) => `countIf(isNull(${ident(c.name)})) AS null_${i}`),
      ...strings.map((c, i) => `uniq(${ident(c.name)}) AS uniq_${i}`),
    ];
    const names = [...new Set([...nullable, ...strings].map(c => ident(c.name)))].join(', ');
    const [row] = await safeRows<Record<string, number>>(
      `SELECT ${exprs.join(', ')} FROM (SELECT ${names} FROM ${target} LIMIT ${SAMPLE_ROWS}) LIMIT 1`,
    );
    if (!row) return;
    const sampled = Number(row.n);
    const severity: RecommendationSeverity = t.total_rows > 10_000_000 ? 'medium' : 'low';

    nullable.forEach((c, i) => {
      if (sampled < 1000 || Number(row[`null_${i}`]) > 0) return;
      const inner = c.type.slice('Nullable('.length, -1);
      recs.push({
        id: `schema:nullable-never-null:${id}.${c.name}`,
        category: 'schema',
        severity,
        title: `${id}.${c.name} is Nullable but contains no NULLs`,
        detail: `None of the ${sampled.toLocaleString()} sampled rows are NULL. Nullable adds a separate null-map file per column and slows down reads; use a plain ${inner} with a default value instead.`,
        target: id,
        remediation: `-- Check the whole table first: SELECT countIf(isNull(${ident(c.name)})) FROM ${target}\nALTER TABLE ${target} MODIFY COLUMN ${ident(c.name)} ${inner};`,
        impact: 'Smaller storage and faster scans of this column',
      });
    });

    strings.forEach((c, i) => {
      const distinct = Number(row[`uniq_${i}`]);
      if (sampled < 10_000 || distinct < 2 || distinct > LOW_CARDINALITY_MAX_DISTINCT || distinct / sampled > 0.1) return;
      const lc = c.type === 'String' ? 'LowCardinality(String)' : 'LowCardinality(Nullable(String))';
      recs.push({
        id: `schema:low-cardinality:${id}.${c.name}`,
        category: 'schema',
        severity,
        title: `${id}.${c.name} could be LowCardinality`,
        detail: `~${distinct.toLocaleString()} distinct values in ${sampled.toLocaleString()} sampled rows. Dictionary-encoding it with ${lc} typically shrinks the column and speeds up filters and GROUP BY.`,
        target: id,
        remediation: `ALTER TABLE ${target} MODIFY COLUMN ${ident(c.name)} ${lc};`,
        impact: 'Typically 2-10x smaller column and faster filtering',
      });
    });
  }));
  return recs;
}

export const schemaProvider: RecommendationProvider = {
  category: 'schema',
  label: 'Schema',
  run: async () => {
    const [tables, columns, logCheck] = await Promise.all([
      safeRows<TableRow>(`
        SELECT database, name, engine, toUInt64(ifNull(total_rows, 0)) AS total_rows, toUInt64(ifNull(total_bytes, 0)) AS total_bytes,
          partition_key, sorting_key
        FROM system.tables
        WHERE ${user} AND engine LIKE '%MergeTree%' AND NOT is_temporary
        LIMIT 20000`),
      // Key columns are excluded: ClickHouse refuses to change their type in place
      safeRows<ColumnRow>(`
        SELECT database, table, name, type FROM system.columns
        WHERE ${user} AND (type LIKE 'Nullable(%' OR type = 'String') AND NOT is_in_sorting_key AND NOT is_in_partition_key
        LIMIT 100000`),
      safeRows<{ covers_window: number }>(`
        SELECT min(event_time) <= now() - INTERVAL 6 DAY AS covers_window FROM system.query_log
        WHERE event_date >= today() - 7 LIMIT 1`),
    ]);
    for (const t of tables) {
      t.total_rows = Number(t.total_rows);
      t.total_bytes = Number(t.total_bytes);
    }
    const dataTables = tables.filter(t => t.total_rows > 0 && !t.name.startsWith('.inner'));
    const recs: Recommendation[] = [];

    for (const t of tables) {
      const id = `${t.database}.${t.name}`;
      const target = `${ident(t.database)}.${ident(t.name)}`;

      if (!t.partition_key && t.total_bytes > UNPARTITIONED_BYTES) {
        const dateCol = columns.find(c => c.database === t.database && c.table === t.name && /^(Nullable\()?Date/.test(c.type));
        recs.push({
          id: `schema:no-partition-key:${id}`,
          category: 'schema',
          severity: bySize(t.total_bytes),
          title: `${id} has no partition key`,
          detail: `${(t.total_bytes / GiB).toFixed(1)} GiB in a single partition makes TTL, retention (DROP PARTITION) and large merges expensive.`,
          target: id,
          remediation:
            `-- Partition keys can't be altered in place: create a partitioned copy and backfill\n` +
            `CREATE TABLE ${ident(t.database)}.${ident(`${t.name}_partitioned`)} AS ${target}\n` +
            `ENGINE = ${t.engine} PARTITION BY toYYYYMM(${dateCol ? ident(dateCol.name) : '<date column>'}) ORDER BY (${t.sorting_key || 'tuple()'});\n` +
            `INSERT INTO ${ident(t.database)}.${ident(`${t.name}_partitioned`)} SELECT * FROM ${target};`,
        });
      }

      const keyParts = splitTopLevel(t.sorting_key);
      if (keyParts.length > WIDE_ORDER_BY) {
        recs.push({
          id: `schema:wide-order-by:${id}`,
          category: 'schema',
          severity: 'low',
          title: `${id} has a ${keyParts.length}-column ORDER BY`,
          detail: `ORDER BY (${t.sorting_key}). Columns beyond the first few rarely help index pruning but make the primary index larger and inserts/merges slower. Keep the 3-4 most frequently filtered, lowest-cardinality-first columns.`,
          target: id,
          remediation: `-- Sorting keys can only be extended in place; recreate with a shorter key, e.g.\n-- ORDER BY (${keyParts.slice(0, 3).join(', ')})`,
        });
      }
    }

    // Unused tables: only trusted when query_log covers the full 7-day window
    if (Number(logCheck[0]?.covers_window) === 1) {
      const used = new Set(
        (await safeRows<{ t: string }>(`
          SELECT DISTINCT arrayJoin(tables) AS t FROM system.query_log
          WHERE event_date >= today() - 7 AND event_time >= now() - INTERVAL 7 DAY AND type = 'QueryFinish'
          LIMIT 100000`)).map(r => r.t),
      );
      for (const t of dataTables) {
        const id = `${t.database}.${t.name}`;
        if (used.has(id)) continue;
        recs.push({
          id: `schema:unused-table:${id}`,
          category: 'schema',
          severity: t.total_bytes > GiB ? 'medium' : 'low',
          title: `${id} has not been queried in 7 days`,
          detail: `No reads or writes in system.query_log over the last 7 days, holding ${t.total_rows.toLocaleString()} rows. It may be obsolete.`,
          target: id,
          remediation: `-- Confirm with the owner first; keep a backup if needed\nDROP TABLE ${ident(t.database)}.${ident(t.name)};`,
          impact: 'Frees storage and reduces merge load',
        });
      }
    }

    return [...recs, ...(await columnChecks(dataTables, columns))];
  },
};
