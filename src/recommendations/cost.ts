// Cost savings recommendations. Signals come from the ClickHouse Cloud API
// (service settings, live memory/CPU, billed usage) and the connected
// server's system tables (compression, TTLs, unused tables, heavy queries).
// Savings are priced with the same cost basis and prices as the Cost page.
import type { Recommendation, RecommendationProvider } from './types';
import {
  envSettings, fetchCloudMetrics, fetchCloudServices, fetchCostSettings, fetchCostStatus, fetchUsage, storageTable, systemTable,
  type CostSettings, type CostStatus,
} from '../components/cost/costApi';
import { BYTES_PER_TB, loadCostBasis, type CostBasis } from '../components/cost/costBasis';
import { optionalRows, queryRows } from '../components/cost/useLiveQuery';
import { addDays, flatMonthForecast, forecastMonth, sumGroups, todayUtc, toUsageRows } from '../components/cost/usage';
import { patternsSql, totalCpuSql, userComputeSql, type PatternRow, type UserCompute } from '../components/cost/workload';
import { formatBytes } from '../utils/formatters';

const MIB = 1024 * 1024;
const LARGE_TABLE_BYTES = 256 * MIB;
const USER_DBS = "database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema')";

const usd = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 2 : 0 })}`;
const perMonth = (v: number) => (v < 1 ? 'Saves under $1/month' : `Saves ~${usd(v)}/month`);
const storageCost = (bytes: number, basis: CostBasis) => (bytes / BYTES_PER_TB) * basis.storageTbMonth;

interface Ctx { status: CostStatus; settings: CostSettings; basis: CostBasis }

// Forecast vs the environment's monthly budget.
async function budgetChecks({ status, settings, basis }: Ctx): Promise<Recommendation[]> {
  const env = envSettings(settings, status.environment);
  if (!env.budget) return [];
  const today = todayUtc();
  let forecast;
  if (status.deployment === 'cloud' && status.cloudApiConfigured) {
    const [usage, services] = await Promise.all([fetchUsage(addDays(today, -40), today), fetchCloudServices()]);
    const rows = toUsageRows(usage.costs, services, status.serviceId).filter(r => env.budgetScope === 'organization' || r.own);
    forecast = forecastMonth(rows, today, env.budget);
  } else if (basis.computeMonthly !== null) {
    forecast = flatMonthForecast(basis.computeMonthly + env.oss.fixedMonthly + (basis.storageMonthly ?? 0), today, env.budget);
  } else {
    return [];
  }
  const ratio = forecast.forecast / env.budget;
  if (ratio * 100 < env.warnPct) return [];
  return [{
    id: `cost:budget:${status.environment}:${forecast.month}`,
    category: 'cost',
    severity: ratio > 1 ? 'critical' : 'high',
    title: ratio > 1 ? `Forecast to exceed the ${usd(env.budget)} monthly budget` : `Forecast at ${Math.round(ratio * 100)}% of the monthly budget`,
    detail: `${status.environment}: ${usd(forecast.monthToDate)} spent so far in ${forecast.month}, forecast ${usd(forecast.forecast)} at ${usd(forecast.dailyRate)}/day.${forecast.overspendDate ? ` Budget runs out on ${forecast.overspendDate}.` : ''}`,
    target: status.environment,
    remediation: 'Review the Cost page (Overview, Usage and Budget tabs) for what is driving spend, or raise the budget if the growth is expected.',
    impact: `${usd(Math.max(0, forecast.forecast - env.budget))} projected overspend`,
  }];
}

// Service-level settings from the Cloud API plus the live memory / CPU snapshot.
async function cloudServiceChecks({ status }: Ctx): Promise<Recommendation[]> {
  if (status.deployment !== 'cloud' || !status.cloudApiConfigured) return [];
  const today = todayUtc();
  const [services, metrics, usage] = await Promise.all([
    fetchCloudServices(),
    fetchCloudMetrics().then(m => m.services).catch(() => []),
    fetchUsage(addDays(today, -30), addDays(today, -1)),
  ]);
  const rows = toUsageRows(usage.costs, services, status.serviceId);
  const recs: Recommendation[] = [];
  const t = sumGroups(rows);
  for (const s of services) {
    const cost = sumGroups(rows.filter(r => r.serviceId === s.id));
    if (!s.idleScaling && s.state !== 'stopped') {
      recs.push({
        id: `cost:idle-scaling-off:${s.id}`, category: 'cost', severity: 'high',
        title: `Enable idle scaling on ${s.name}`,
        detail: `Idle scaling is off, so ${s.name} bills compute around the clock (${usd(cost.Compute)} in the last 30 days) even when no queries run.`,
        target: s.name,
        remediation: 'ClickHouse Cloud console > service > Settings > Scaling: enable "Allow scale to zero" with a 5-15 minute idle timeout (or PATCH /v1/organizations/{org}/services/{id}/scaling with idleScaling: true).',
        impact: `${usd(cost.Compute)}/month of always-on compute`,
      });
    } else if (s.idleScaling && (s.idleTimeoutMinutes ?? 0) > 30 && cost.Compute > 0) {
      recs.push({
        id: `cost:idle-timeout:${s.id}`, category: 'cost', severity: 'low',
        title: `Shorten the idle timeout on ${s.name}`,
        detail: `The service keeps running ${s.idleTimeoutMinutes} minutes after the last query before scaling to zero. Each wake-up pays for that tail.`,
        target: s.name,
        remediation: 'Lower idleTimeoutMinutes to 5-15 minutes unless clients reconnect constantly.',
      });
    }
    // Live snapshot: low memory and CPU on a running service suggests a smaller size
    const live = metrics.find(m => m.serviceId === s.id)?.replicas || [];
    if (s.state === 'running' && live.length && s.minReplicaMemoryGb > 8 && cost.Compute > 0) {
      const used = live.reduce((a, r) => a + (r.memoryUsed || 0), 0);
      const total = live.reduce((a, r) => a + (r.memoryTotal || 0), 0) || 1;
      const cpu = live.reduce((a, r) => a + (r.cpuUser || 0) + (r.cpuSystem || 0), 0) / live.length;
      const usedPerReplicaGb = used / live.length / 1024 ** 3;
      const target = Math.max(8, Math.ceil((usedPerReplicaGb * 2) / 4) * 4);
      if (used / total < 0.3 && cpu < 0.2 && target < s.minReplicaMemoryGb) {
        const saving = cost.Compute * (1 - target / s.minReplicaMemoryGb);
        recs.push({
          id: `cost:oversized:${s.id}`, category: 'cost', severity: saving > 100 ? 'high' : 'medium',
          title: `${s.name} looks over-provisioned`,
          detail: `Right now each replica uses ${Math.round((used / total) * 100)}% of its memory and ${Math.round(cpu * 100)}% CPU. A minimum of ${target} GiB per replica (from ${s.minReplicaMemoryGb} GiB) would leave 2x headroom. This is a point-in-time reading: check peak usage before resizing.`,
          target: s.name,
          remediation: `Lower minReplicaMemoryGb to ${target} (keep maxReplicaMemoryGb for bursts) in the service scaling settings.`,
          impact: perMonth(saving),
          estimatedMonthlySaving: saving,
        });
      }
    }
    if (s.state === 'stopped' && cost.Storage + cost.Backup > 0) {
      recs.push({
        id: `cost:stopped-storage:${s.id}`, category: 'cost', severity: 'low',
        title: `Stopped service ${s.name} still pays for storage`,
        detail: `${s.name} is stopped but its warehouse billed ${usd(cost.Storage + cost.Backup)} for storage and backups in the last 30 days.`,
        target: s.name,
        remediation: 'Delete the service (after a final backup) if it is no longer needed.',
        impact: perMonth(cost.Storage + cost.Backup),
        estimatedMonthlySaving: cost.Storage + cost.Backup,
      });
    }
  }
  if (t.total > 0 && t['Data transfer'] / t.total > 0.2) {
    recs.push({
      id: 'cost:data-transfer-share', category: 'cost', severity: 'medium',
      title: 'Data transfer is a large share of spend',
      detail: `Egress cost ${usd(t['Data transfer'])} over the last 30 days, ${Math.round((t['Data transfer'] / t.total) * 100)}% of the organisation's bill.`,
      remediation: 'Run clients in the same cloud region, request compressed responses (enable_http_compression=1), and avoid exporting large result sets over the public internet.',
      impact: `${usd(t['Data transfer'])}/month of data transfer`,
    });
  }
  return recs;
}

async function compressionChecks({ status, basis }: Ctx): Promise<Recommendation[]> {
  const rows = await queryRows<{ database: string; table: string; bytes: number; compressed: number; uncompressed: number }>(`
    SELECT database, table, sum(bytes_on_disk) AS bytes, sum(data_compressed_bytes) AS compressed, sum(data_uncompressed_bytes) AS uncompressed
    FROM ${storageTable(status, 'parts')}
    WHERE active AND ${USER_DBS}
    GROUP BY database, table
    HAVING bytes > ${LARGE_TABLE_BYTES} AND uncompressed < compressed * 3`);
  return rows.map(r => {
    const ratio = r.compressed ? r.uncompressed / r.compressed : 1;
    // Assume 4x is reachable with better codecs / ordering, a common outcome for analytical data
    const saving = storageCost(r.bytes * (1 - ratio / 4), basis);
    return {
      id: `cost:poor-compression:${r.database}.${r.table}`, category: 'cost', severity: r.bytes > 50 * 1024 * MIB ? 'medium' : 'low',
      title: `Poor compression on ${r.database}.${r.table}`,
      detail: `${formatBytes(r.bytes)} on disk at only ${ratio.toFixed(1)}x compression. Reaching 4x would cut storage by ${Math.round((1 - ratio / 4) * 100)}%.`,
      target: `${r.database}.${r.table}`,
      remediation: `Inspect per-column ratios (SELECT name, data_compressed_bytes, data_uncompressed_bytes FROM system.columns WHERE database = '${r.database}' AND table = '${r.table}'), then use ZSTD / Delta / LowCardinality codecs and an ORDER BY that groups similar values.`,
      impact: saving > 0 ? perMonth(saving) : undefined,
      estimatedMonthlySaving: saving > 0 ? saving : undefined,
    } satisfies Recommendation;
  });
}

async function ttlChecks({ status, settings, basis }: Ctx): Promise<Recommendation[]> {
  const days = envSettings(settings, status.environment).ttlDays;
  const [old, ttl] = await Promise.all([
    // Partition dates tell how old a part's data is; 1970 means not time-partitioned
    queryRows<{ database: string; table: string; old_bytes: number; oldest: string }>(`
      SELECT database, table,
        sumIf(bytes_on_disk, newest < today() - ${days}) AS old_bytes, toString(min(newest)) AS oldest
      FROM (
        SELECT database, table, bytes_on_disk, greatest(max_date, toDate(max_time)) AS newest
        FROM ${storageTable(status, 'parts')}
        WHERE active AND ${USER_DBS}
      )
      WHERE newest > toDate('1970-01-02')
      GROUP BY database, table
      HAVING old_bytes > ${64 * MIB}`),
    queryRows<{ database: string; table: string }>(`
      SELECT DISTINCT database, name AS table FROM ${storageTable(status, 'tables')}
      WHERE engine LIKE '%MergeTree%' AND positionCaseInsensitive(create_table_query, ' TTL ') > 0`),
  ]);
  const withTtl = new Set(ttl.map(t => `${t.database}.${t.table}`));
  return old.filter(r => !withTtl.has(`${r.database}.${r.table}`)).map(r => {
    const saving = storageCost(r.old_bytes, basis);
    return {
      id: `cost:no-ttl:${r.database}.${r.table}`, category: 'cost', severity: saving > 50 ? 'medium' : 'low',
      title: `${r.database}.${r.table} keeps data older than ${days} days with no TTL`,
      detail: `${formatBytes(r.old_bytes)} is in partitions older than ${days} days (oldest from ${r.oldest}) and the table has no TTL, so it is kept forever.`,
      target: `${r.database}.${r.table}`,
      remediation: `If old rows are not needed: ALTER TABLE ${r.database}.${r.table} MODIFY TTL <date column> + INTERVAL ${days} DAY. To keep but cheapen them, use a TTL ... TO VOLUME rule on self-managed tiers.`,
      impact: perMonth(saving),
      estimatedMonthlySaving: saving,
    } satisfies Recommendation;
  });
}

async function unusedTableChecks({ status, basis }: Ctx): Promise<Recommendation[]> {
  const window = await optionalRows<{ days: number }>(`SELECT dateDiff('day', min(event_time), now()) AS days FROM ${systemTable(status, 'query_log')}`);
  const observed = Math.min(30, window?.[0]?.days ?? 0);
  // Needs at least a week of history to call a table unused
  if (observed < 7) return [];
  const [tables, used] = await Promise.all([
    queryRows<{ database: string; table: string; bytes: number }>(`
      SELECT database, table, sum(bytes_on_disk) AS bytes FROM ${storageTable(status, 'parts')}
      WHERE active AND ${USER_DBS} GROUP BY database, table HAVING bytes > ${LARGE_TABLE_BYTES}`),
    queryRows<{ t: string }>(`
      SELECT DISTINCT arrayJoin(tables) AS t FROM ${systemTable(status, 'query_log')}
      WHERE event_date >= today() - 30 AND type = 'QueryFinish' AND query_kind = 'Select'`),
  ]);
  const usedSet = new Set(used.map(u => u.t));
  return tables.filter(t => !usedSet.has(`${t.database}.${t.table}`)).map(t => {
    const saving = storageCost(t.bytes, basis);
    return {
      id: `cost:unused-table:${t.database}.${t.table}`, category: 'cost', severity: saving > 50 ? 'medium' : 'low',
      title: `${t.database}.${t.table} has not been read in ${observed} days`,
      detail: `${formatBytes(t.bytes)} stored, but no SELECT in system.query_log over the last ${observed} days referenced it.`,
      target: `${t.database}.${t.table}`,
      remediation: `Confirm nothing outside this service reads it, then archive it (e.g. INSERT INTO FUNCTION s3(...) SELECT * FROM ${t.database}.${t.table}) and drop it.`,
      impact: perMonth(saving),
      estimatedMonthlySaving: saving,
    } satisfies Recommendation;
  });
}

async function workloadChecks({ status, basis }: Ctx): Promise<Recommendation[]> {
  const [patterns, total, users] = await Promise.all([
    optionalRows<PatternRow>(patternsSql(status, 7, 5)),
    optionalRows<{ cpu_s: number }>(totalCpuSql(status, 7)),
    optionalRows<UserCompute>(userComputeSql(status, 7)),
  ]);
  const totalCpu = total?.[0]?.cpu_s || 0;
  if (!patterns || !totalCpu) return [];
  const costOf = (share: number) => (basis.computeMonthly === null ? '' : ` (~${usd(share * basis.computeMonthly)}/month of compute)`);
  const recs: Recommendation[] = patterns.filter(p => p.cpu_s / totalCpu > 0.15).map(p => {
    const share = p.cpu_s / totalCpu;
    return {
      id: `cost:heavy-pattern:${p.hash}`, category: 'cost', severity: share > 0.4 ? 'high' : 'medium',
      title: `One query pattern uses ${Math.round(share * 100)}% of CPU`,
      detail: `Pattern ${p.hash} (${p.kind} by ${p.user}${p.database ? ` on ${p.database}` : ''}) ran ${p.queries.toLocaleString()} times in 7 days for ${p.cpu_s.toFixed(0)} CPU seconds and read ${formatBytes(p.read_bytes)}${costOf(share)}. Query: ${p.sample.slice(0, 160)}`,
      target: p.hash,
      remediation: 'Check whether it can read less (tighter WHERE on the primary key, a projection or materialized view), run less often, or be cached.',
      impact: `${Math.round(share * 100)}% of workload CPU${costOf(share)}`,
    };
  });
  const users7 = users || [];
  const top = users7[0];
  if (top && users7.length > 1 && top.cpu_s / totalCpu > 0.5) {
    const share = top.cpu_s / totalCpu;
    recs.push({
      id: `cost:heavy-user:${top.user}`, category: 'cost', severity: 'low',
      title: `User ${top.user} drives ${Math.round(share * 100)}% of compute`,
      detail: `${top.user} ran ${top.queries.toLocaleString()} queries in 7 days using ${top.cpu_s.toFixed(0)} CPU seconds${costOf(share)}.`,
      target: top.user,
      remediation: 'Review the queries of this user in Observability › Queries and consider a quota or settings profile limiting max_threads / max_execution_time.',
      impact: `${Math.round(share * 100)}% of workload CPU`,
    });
  }
  return recs;
}

// Self-managed: average CPU across the nodes against the per-node price.
async function ossUtilisationChecks({ status, settings, basis }: Ctx): Promise<Recommendation[]> {
  const env = envSettings(settings, status.environment);
  if (status.deployment !== 'oss' || !env.oss.nodeMonthly || !basis.nodes) return [];
  const rows = await optionalRows<{ util: number }>(`
    SELECT avg(cores_used / greatest(cores, 1)) AS util FROM (
      SELECT hostName() AS host,
        sum(ProfileEvent_OSCPUVirtualTimeMicroseconds) / 1e6 / greatest(dateDiff('second', min(event_time), max(event_time)), 1) AS cores_used,
        (SELECT toUInt32OrZero(extract(value, '\\\\d+')) FROM system.settings WHERE name = 'max_threads') AS cores
      FROM ${systemTable(status, 'metric_log')} WHERE event_date >= today() - 7 GROUP BY host)`);
  const util = rows?.[0]?.util;
  if (util === undefined || util === null || util >= 0.15) return [];
  // Size for 50% average CPU, keeping at least one node
  const needed = Math.max(1, Math.ceil((basis.nodes * util) / 0.5));
  const removable = basis.nodes - needed;
  const saving = removable > 0 ? removable * env.oss.nodeMonthly : env.oss.nodeMonthly * 0.5;
  return [{
    id: `cost:oss-underused:${status.environment}`, category: 'cost', severity: 'medium',
    title: `Nodes average ${Math.round(util * 100)}% CPU over 7 days`,
    detail: `${basis.nodes} node(s) at ${usd(env.oss.nodeMonthly)}/month each are mostly idle. ${removable > 0 ? `${needed} node(s) would run at about 50% CPU.` : 'A smaller instance type would still leave headroom.'} Check memory and peak load before resizing.`,
    target: status.environment,
    remediation: removable > 0 ? `Consolidate to ${needed} node(s) (keep replicas for availability).` : 'Move to an instance with half the vCPUs / memory.',
    impact: perMonth(saving),
    estimatedMonthlySaving: saving,
  }];
}

export const costProvider: RecommendationProvider = {
  category: 'cost',
  label: 'Cost',
  run: async () => {
    try {
      const [status, settings] = await Promise.all([fetchCostStatus(), fetchCostSettings()]);
      const basis = await loadCostBasis(status, settings);
      const ctx = { status, settings, basis };
      const results = await Promise.allSettled([
        budgetChecks(ctx), cloudServiceChecks(ctx), compressionChecks(ctx), ttlChecks(ctx),
        unusedTableChecks(ctx), workloadChecks(ctx), ossUtilisationChecks(ctx),
      ]);
      return results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
    } catch {
      return [];
    }
  },
};
