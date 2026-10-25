// Real-data calibration for the simulated load test: each query's unloaded
// p50/p95 comes from system.query_log (matched by normalized_query_hash), then
// from QueryDog's own run stats for the saved .sql file, then a shape estimate.
import { executeQuery } from '../../services/api';
import { estimateCalibration } from './engine';
import type { Calibration, PoolQuery } from './model';

export async function fetchSavedQueries(): Promise<PoolQuery[]> {
  const res = await fetch('/api/my-queries');
  if (!res.ok) throw new Error(`Failed to load saved queries (${res.status})`);
  const data = await res.json();
  return ((data?.queries || []) as { filename: string; query: string; avgRunTime: number | null; slowestRunTime: number | null; runCount?: number }[])
    .map(q => ({ name: q.filename, sql: q.query, avgRunTime: q.avgRunTime, slowestRunTime: q.slowestRunTime, runCount: q.runCount ?? 0 }));
}

const literal = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

// The texts ClickHouse actually logs for a saved query: as written, as sent by the
// QueryDog runners (format appended, and LIMIT for unlimited SELECTs via /api/query)
function loggedVariants(sql: string): string[] {
  const base = sql.trim().replace(/;+\s*$/, '').trim();
  return [base, `${base} \nFORMAT JSON`, `${base} \nFORMAT JSONEachRow`, `${base} LIMIT 1000 \nFORMAT JSONEachRow`];
}
const VARIANTS = 4;

export function queryLogCalibrationSql(sqls: string[]): string {
  const texts = sqls.flatMap(loggedVariants).map(literal).join(',\n  ');
  return `WITH arrayMap(x -> normalizedQueryHash(x), [
  ${texts}
]) AS hs
SELECT
  arrayDistinct(arrayMap(i -> intDiv(i - 1, ${VARIANTS}), arrayFilter(i -> hs[i] = normalized_query_hash, arrayEnumerate(hs)))) AS idxs,
  countIf(type = 'QueryFinish') AS runs,
  countIf(type != 'QueryFinish') AS failed,
  round(quantileIf(0.5)(query_duration_ms, type = 'QueryFinish')) AS p50,
  round(quantileIf(0.95)(query_duration_ms, type = 'QueryFinish')) AS p95
FROM system.query_log
WHERE event_date >= today() - 7 AND type != 'QueryStart' AND has(hs, normalized_query_hash)
GROUP BY normalized_query_hash`;
}

export interface CalibrationResult {
  bySql: Record<string, Calibration>;
  queryLogError: string | null;
}

const MIN_LOG_RUNS = 3;

export async function calibrate(sqls: string[], pool: PoolQuery[]): Promise<CalibrationResult> {
  const unique = [...new Set(sqls)];
  const fromLog = new Map<number, { runs: number; failed: number; p50: number; p95: number }>();
  let queryLogError: string | null = null;
  if (unique.length) {
    try {
      const res = await executeQuery(queryLogCalibrationSql(unique));
      // A query can match several logged variants (and several queries one hash): merge run-weighted
      for (const r of res.data as Record<string, unknown>[]) {
        const runs = Number(r.runs);
        const p50 = runs ? Number(r.p50) : 0;
        const p95 = runs ? Number(r.p95) : 0;
        for (const idx of r.idxs as number[]) {
          const prev = fromLog.get(Number(idx)) ?? { runs: 0, failed: 0, p50: 0, p95: 0 };
          const total = prev.runs + runs;
          fromLog.set(Number(idx), {
            runs: total,
            failed: prev.failed + Number(r.failed),
            p50: total ? (prev.p50 * prev.runs + p50 * runs) / total : 0,
            p95: total ? (prev.p95 * prev.runs + p95 * runs) / total : 0,
          });
        }
      }
    } catch (e) {
      queryLogError = e instanceof Error ? e.message : String(e);
    }
  }

  const bySql: Record<string, Calibration> = {};
  unique.forEach((sql, i) => {
    const log = fromLog.get(i);
    const saved = pool.find(q => q.sql === sql);
    if (log && log.runs >= MIN_LOG_RUNS) {
      const errorPct = (log.failed / (log.runs + log.failed)) * 100;
      bySql[sql] = {
        p50Ms: Math.max(1, log.p50), p95Ms: Math.max(1, log.p95), errorPct, source: 'query_log',
        detail: `system.query_log, last 7 days: ${log.runs} runs, ${log.failed} failed, p50 ${Math.round(log.p50)}ms, p95 ${Math.round(log.p95)}ms`,
      };
    } else if (saved?.avgRunTime != null) {
      const p50 = Math.max(1, saved.avgRunTime);
      const p95 = saved.runCount > 1 && saved.slowestRunTime != null ? Math.max(saved.slowestRunTime, p50 * 1.1) : p50 * 2;
      bySql[sql] = {
        p50Ms: p50, p95Ms: p95, errorPct: 0.1, source: 'saved_runs',
        detail: `QueryDog run stats: ${saved.runCount} run(s), avg ${Math.round(p50)}ms${saved.slowestRunTime != null ? `, slowest ${Math.round(saved.slowestRunTime)}ms` : ''}`,
      };
    } else {
      bySql[sql] = estimateCalibration(sql);
    }
  });
  return { bySql, queryLogError };
}
