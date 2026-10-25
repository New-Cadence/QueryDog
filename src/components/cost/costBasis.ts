// The monthly compute / storage cost that the live-data views (query
// patterns, showback, storage growth) and the cost recommendations divide up.
// Cloud with an API key: the connected service's real spend over the last 30
// days. Open source: the user's node and storage prices. Otherwise unknown.
import { executeQuery } from '../../services/api';
import {
  effectivePrice, envSettings, fetchCloudServices, fetchUsage, storageTable,
  type CloudService, type CostSettings, type CostStatus,
} from './costApi';
import { regionKey, toTier, LIST_PRICES, type Tier } from './pricing';
import { addDays, sumGroups, todayUtc, toUsageRows } from './usage';

export interface CostBasis {
  // $ per month attributable to compute on this environment (null = unknown)
  computeMonthly: number | null;
  // $ per month for stored data (storage + backups on Cloud)
  storageMonthly: number | null;
  // Self-managed costs not tied to nodes or bytes
  fixedMonthly?: number;
  // $ per TB-month used to price bytes (list or user price)
  storageTbMonth: number;
  source: 'cloud-api' | 'oss' | 'unpriced';
  label: string;
  // Extra context for Cloud: the connected service and the price tier
  service?: CloudService | null;
  tier?: Tier;
  nodes?: number;
}

export const BYTES_PER_TB = 1e12;

export async function countOssNodes(status: CostStatus): Promise<number> {
  try {
    const where = status.cluster ? `WHERE cluster = '${status.cluster.replace(/'/g, "\\'")}'` : '';
    const r = await executeQuery(`SELECT uniqExact(host_name, port) AS n FROM system.clusters ${where}`, 1);
    return Math.max(1, Number(r.data[0]?.n) || 0);
  } catch {
    return 1;
  }
}

export async function loadCostBasis(status: CostStatus, settings: CostSettings): Promise<CostBasis> {
  const env = envSettings(settings, status.environment);
  if (status.deployment === 'oss') {
    const [nodes, bytes] = await Promise.all([
      env.oss.nodeCountOverride || countOssNodes(status),
      executeQuery(`SELECT sum(bytes_on_disk) AS b FROM ${storageTable(status, 'parts')} WHERE active`, 1).then(r => Number(r.data[0]?.b) || 0).catch(() => 0),
    ]);
    const priced = env.oss.nodeMonthly > 0;
    return {
      computeMonthly: priced ? env.oss.nodeMonthly * nodes : null,
      storageMonthly: (bytes / BYTES_PER_TB) * env.oss.storageTbMonth,
      fixedMonthly: env.oss.fixedMonthly,
      storageTbMonth: env.oss.storageTbMonth,
      source: priced ? 'oss' : 'unpriced',
      label: priced ? `${nodes} node${nodes === 1 ? '' : 's'} × $${env.oss.nodeMonthly}/month (your prices)` : 'Set node prices in Settings',
      nodes,
    };
  }

  const fallbackRate = LIST_PRICES['us-east-1'].storageTbMonth;
  if (!status.cloudApiConfigured) {
    return { computeMonthly: null, storageMonthly: null, storageTbMonth: fallbackRate, source: 'unpriced', label: 'Configure cloud_api for real spend' };
  }
  const to = addDays(todayUtc(), -1);
  const from = addDays(to, -29);
  const [usage, services] = await Promise.all([fetchUsage(from, to), fetchCloudServices()]);
  const own = services.find(s => s.isOwn) || null;
  const rows = toUsageRows(usage.costs, services, status.serviceId);
  const scoped = own ? rows.filter(r => r.own) : rows;
  const t = sumGroups(scoped);
  const price = own ? effectivePrice(settings, regionKey(own.provider, own.region)) : null;
  const tier = toTier(usage.costs[0]?.organizationTier || own?.tier);
  return {
    computeMonthly: t.Compute,
    storageMonthly: t.Storage + t.Backup,
    storageTbMonth: price?.storageTbMonth ?? fallbackRate,
    source: 'cloud-api',
    label: own ? `${own.name}: last 30 days of billed usage` : 'Whole organisation: last 30 days of billed usage',
    service: own,
    tier,
  };
}

