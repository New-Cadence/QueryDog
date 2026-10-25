// Client for the Cost server extension (server/extensions/cost.js) plus the
// shared settings model used by the Cost page and the cost recommendations.
import { LIST_PRICES, type RegionPrice, type Tier } from './pricing';

export interface CostStatus {
  environment: string;
  deployment: 'cloud' | 'oss';
  cluster: string | null;
  cloudApiConfigured: boolean;
  missing: string[];
  organizationId: string | null;
  serviceId: string | null;
}

export interface UsageRecord {
  date: string;
  entityType: 'datawarehouse' | 'service' | 'clickpipe' | string;
  entityId: string;
  entityName: string;
  serviceId: string | null;
  dataWarehouseId: string | null;
  organizationTier: string | null;
  locked: boolean;
  metrics: Record<string, number>;
  totalCHC: number;
}

export interface CloudService {
  id: string;
  name: string;
  provider: string;
  region: string;
  state: string;
  tier: string | null;
  clickhouseVersion: string | null;
  createdAt: string | null;
  dataWarehouseId: string | null;
  isPrimary: boolean | null;
  isReadonly: boolean | null;
  releaseChannel: string | null;
  profile: string | null;
  autoscalingMode: string;
  numReplicas: number;
  maxReplicas: number;
  minReplicaMemoryGb: number;
  maxReplicaMemoryGb: number;
  idleScaling: boolean;
  idleTimeoutMinutes: number | null;
  tags: string[];
  isOwn: boolean;
}

export interface OrganizationInfo {
  organization: { id: string; name: string; createdAt: string | null };
  credits: { totalRemaining: number; balances: { id: string; type: string; remaining: number; total: number; spent: number; startDate: string; expirationDate: string }[] } | null;
}

export interface ReplicaMetrics {
  hostname: string;
  memoryUsed?: number;
  memoryTotal?: number;
  maxCpu?: number;
  cpuUser?: number;
  cpuSystem?: number;
  mergeTreeBytes?: number;
  mergeTreeRows?: number;
}

export interface ServiceMetrics {
  serviceId: string;
  name: string;
  status: string | null;
  version: string | null;
  replicas: ReplicaMetrics[];
}

// ==================== Settings ====================

export interface OssPricing {
  nodeMonthly: number;
  storageTbMonth: number;
  fixedMonthly: number;
  nodeCountOverride: number | null;
}

export interface EnvCostSettings {
  budget: number | null;
  // Cloud: whether the budget covers this environment's service or the whole organisation
  budgetScope: 'service' | 'organization';
  // Warn when the month-end forecast passes this % of the budget
  warnPct: number;
  // Data older than this with no TTL is flagged by the cost recommendations
  ttlDays: number;
  oss: OssPricing;
}

// A team that ClickHouse Cloud spend is allocated to (Settings > Cost allocation).
// Services are Cloud service ids; each service belongs to at most one team.
export interface CostTeam {
  id: string;
  name: string;
  services: string[];
}

export interface CostSettings {
  // Per-region overrides of the list prices
  prices: Record<string, Partial<Omit<RegionPrice, 'label' | 'compute'>> & { compute?: Partial<Record<Tier, number>> }>;
  envs: Record<string, Partial<EnvCostSettings>>;
  teams?: CostTeam[];
}

export const DEFAULT_ENV_SETTINGS: EnvCostSettings = {
  budget: null,
  // The bill is per organisation, so that is what a budget usually covers
  budgetScope: 'organization',
  warnPct: 80,
  ttlDays: 90,
  oss: { nodeMonthly: 0, storageTbMonth: 0, fixedMonthly: 0, nodeCountOverride: null },
};

export function envSettings(settings: CostSettings, env: string): EnvCostSettings {
  const s = settings.envs[env] || {};
  return { ...DEFAULT_ENV_SETTINGS, ...s, oss: { ...DEFAULT_ENV_SETTINGS.oss, ...(s.oss || {}) } };
}

// List price for a region with the user's overrides applied.
export function effectivePrice(settings: CostSettings, key: string): RegionPrice | null {
  const base = LIST_PRICES[key];
  const o = settings.prices[key];
  if (!base) return null;
  if (!o) return base;
  return {
    ...base,
    ...o,
    compute: { ...base.compute, ...(o.compute || {}) },
  } as RegionPrice;
}

// ==================== Fetch helpers ====================

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api/cost${path}`);
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body as T;
}

const q = (refresh?: boolean) => (refresh ? 'refresh=1' : '');

export const fetchCostStatus = () => getJson<CostStatus>('/status');
export const fetchCostSettings = () => getJson<CostSettings>('/settings');
export const fetchCloudServices = (refresh?: boolean) =>
  getJson<{ services: CloudService[] }>(`/cloud/services?${q(refresh)}`).then(r => r.services);
export const fetchOrganization = (refresh?: boolean) => getJson<OrganizationInfo>(`/cloud/organization?${q(refresh)}`);
export const fetchCloudMetrics = (refresh?: boolean) =>
  getJson<{ fetchedAt: string; services: ServiceMetrics[] }>(`/cloud/metrics?${q(refresh)}`);
export const fetchUsage = (from: string, to: string, refresh?: boolean) =>
  getJson<{ from_date: string; to_date: string; grandTotalCHC: number; costs: UsageRecord[] }>(
    `/cloud/usage?from_date=${from}&to_date=${to}&${q(refresh)}`,
  );

export async function saveCostSettings(settings: CostSettings): Promise<CostSettings> {
  const res = await fetch('/api/cost/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(body.error || 'Failed to save cost settings');
  return body;
}

// Per-replica system logs (query_log, part_log, metric logs) read across every
// replica when the environment is a cluster (cluster: true in querydog.yml).
export function systemTable(status: Pick<CostStatus, 'deployment' | 'cluster'>, table: string): string {
  const cluster = status.cluster;
  return cluster ? `clusterAllReplicas('${cluster.replace(/'/g, "\\'")}', system.${table})` : `system.${table}`;
}

// system.parts / system.tables: Cloud replicas share one copy of the data, so
// read them locally; self-managed replicas each store their own copy.
export function storageTable(status: Pick<CostStatus, 'deployment' | 'cluster'>, table: 'parts' | 'tables'): string {
  return status.deployment === 'cloud' ? `system.${table}` : systemTable(status, table);
}
