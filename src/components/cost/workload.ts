// query_log SQL shared by the query-cost, attribution and recommendation
// code. Compute cost is divided by CPU time (OSCPUVirtualTimeMicroseconds).
import type { CostStatus } from './costApi';
import { systemTable } from './costApi';

type Status = Pick<CostStatus, 'deployment' | 'cluster'>;

// The last N days, or an inclusive range of YYYY-MM-DD dates
export type Window = number | { from: string; to: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ClickHouse Cloud runs its own monitoring as '*-internal' users (and some
// background work with no user); that is not customer workload to allocate.
export function workloadWhere(status: Status, window: Window): string {
  const internal = status.deployment === 'cloud' ? "AND NOT (user = '' OR user LIKE '%-internal')" : '';
  let when: string;
  if (typeof window === 'number') {
    when = `event_date >= today() - ${window} AND event_time > now() - INTERVAL ${window} DAY`;
  } else {
    if (!DATE.test(window.from) || !DATE.test(window.to)) throw new Error('Invalid date range');
    when = `event_date >= toDate('${window.from}') AND event_date <= toDate('${window.to}')`;
  }
  return `${when}
    AND type IN ('QueryFinish', 'ExceptionWhileProcessing') ${internal}`;
}

export const CPU_SECONDS = "ProfileEvents['OSCPUVirtualTimeMicroseconds'] / 1e6";

export const internalUsersNote = (status: Status) =>
  status.deployment === 'cloud' ? 'ClickHouse Cloud internal users (*-internal) are excluded. ' : '';

export interface PatternRow {
  hash: string;
  user: string;
  kind: string;
  database: string;
  sample: string;
  queries: number;
  cpu_s: number;
  read_bytes: number;
  read_rows: number;
  duration_s: number;
  peak_memory: number;
  failed: number;
}

export function patternsSql(status: Status, window: Window, limit = 500): string {
  return `
    SELECT toString(normalized_query_hash) AS hash, user, toString(query_kind) AS kind,
      if(empty(databases), '', databases[1]) AS database,
      any(substring(replaceRegexpAll(query, '\\\\s+', ' '), 1, 400)) AS sample,
      count() AS queries, sum(${CPU_SECONDS}) AS cpu_s,
      sum(read_bytes) AS read_bytes, sum(read_rows) AS read_rows,
      sum(query_duration_ms) / 1000 AS duration_s, max(memory_usage) AS peak_memory,
      countIf(type != 'QueryFinish') AS failed
    FROM ${systemTable(status, 'query_log')}
    WHERE ${workloadWhere(status, window)}
    GROUP BY hash, user, kind, database
    ORDER BY cpu_s DESC
    LIMIT ${limit}`;
}

export function totalCpuSql(status: Status, window: Window): string {
  return `SELECT sum(${CPU_SECONDS}) AS cpu_s, count() AS queries FROM ${systemTable(status, 'query_log')} WHERE ${workloadWhere(status, window)}`;
}

export interface UserCompute { user: string; queries: number; cpu_s: number; read_bytes: number }

export function userComputeSql(status: Status, window: Window): string {
  return `
    SELECT user, count() AS queries, sum(${CPU_SECONDS}) AS cpu_s, sum(read_bytes) AS read_bytes
    FROM ${systemTable(status, 'query_log')}
    WHERE ${workloadWhere(status, window)}
    GROUP BY user ORDER BY cpu_s DESC`;
}

export interface DatabaseCompute { database: string; queries: number; cpu_s: number }

// A query touching several databases splits its CPU evenly between them.
export function databaseComputeSql(status: Status, window: Window): string {
  return `
    SELECT database, count() AS queries, sum(cpu) AS cpu_s
    FROM (
      SELECT arrayJoin(if(empty(databases), [''], databases)) AS database,
        ${CPU_SECONDS} / greatest(length(databases), 1) AS cpu
      FROM ${systemTable(status, 'query_log')}
      WHERE ${workloadWhere(status, window)}
    )
    GROUP BY database ORDER BY cpu_s DESC`;
}
