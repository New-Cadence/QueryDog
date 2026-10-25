// Services joined with their billed usage, list prices and live metrics.
import { useMemo } from 'react';
import { effectivePrice, type CloudService, type ServiceMetrics } from './costApi';
import { useCost } from './costContext';
import { GIB_PER_UNIT, regionKey, toTier } from './pricing';
import { addDays, sumGroups } from './usage';
import type { CloudData } from './useCloudData';

export interface ServiceRow extends CloudService {
  // Billed over the window passed to useServiceRows (default: last 30 days)
  compute: number;
  storage: number;
  total: number;
  hourlyListPrice: number | null;
  impliedHoursPerDay: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  cpuUtil: number | null;
  mergeTreeBytes: number | null;
  liveReplicas: number;
}

// Joins the service list with billed usage over a window, list prices and the
// live Prometheus snapshot so each service shows what it costs and how busy it is.
export function useServiceRows(data: CloudData | undefined, window?: { from: string; to: string }): ServiceRow[] {
  const { settings } = useCost();
  const from = window?.from ?? (data ? addDays(data.to, -29) : '');
  const to = window?.to ?? data?.to ?? '';
  return useMemo(() => {
    if (!data) return [];
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const orgTier = toTier(data.records[0]?.organizationTier);
    const live = new Map<string, ServiceMetrics>(data.metrics.map(m => [m.serviceId, m]));
    return data.services.map(s => {
      const t = sumGroups(data.rows.filter(r => r.serviceId === s.id && r.date >= from && r.date <= to));
      const price = effectivePrice(settings, regionKey(s.provider, s.region));
      const unitPrice = price ? price.compute[s.tier ? toTier(s.tier) : orgTier] : null;
      const hourly = unitPrice !== null ? (s.minReplicaMemoryGb / GIB_PER_UNIT) * s.numReplicas * unitPrice : null;
      const replicas = live.get(s.id)?.replicas || [];
      const sum = (k: 'memoryUsed' | 'memoryTotal') => (replicas.length ? replicas.reduce((a, r) => a + (r[k] || 0), 0) : null);
      const cpu = replicas.length ? replicas.reduce((a, r) => a + (r.cpuUser || 0) + (r.cpuSystem || 0), 0) / replicas.length : null;
      return {
        ...s,
        compute: t.Compute,
        storage: t.Storage + t.Backup,
        total: t.total,
        hourlyListPrice: hourly,
        impliedHoursPerDay: hourly ? Math.min(24, t.Compute / days / hourly) : null,
        memoryUsed: sum('memoryUsed'),
        memoryTotal: sum('memoryTotal'),
        cpuUtil: cpu,
        mergeTreeBytes: replicas.length ? Math.max(...replicas.map(r => r.mergeTreeBytes || 0)) : null,
        liveReplicas: replicas.length,
      };
    });
  }, [data, settings, from, to]);
}

