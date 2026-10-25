// Pure helpers that turn ClickHouse Cloud usageCost records into the
// series, breakdowns and forecasts shown on the Cost page. Amounts are
// ClickHouse Credits (CHC); 1 CHC is billed as $1 at list price.
import type { ClientFilterField } from '../../hooks/useClientFilters';
import type { CloudService, UsageRecord } from './costApi';

export const METRIC_GROUPS = ['Compute', 'Storage', 'Backup', 'Data transfer', 'ClickPipes'] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];

export function metricGroup(entityType: string, metric: string): MetricGroup {
  if (entityType === 'clickpipe' || metric === 'initialLoadCHC') return 'ClickPipes';
  if (metric === 'storageCHC') return 'Storage';
  if (metric === 'backupCHC') return 'Backup';
  if (/DataTransferCHC$/i.test(metric)) return 'Data transfer';
  return 'Compute';
}

export type GroupTotals = Record<MetricGroup, number>;

const emptyTotals = (): GroupTotals => ({ Compute: 0, Storage: 0, Backup: 0, 'Data transfer': 0, ClickPipes: 0 });

// One usage record flattened for grids and filters. `service` is the name of
// the service the cost belongs to: warehouse storage / backup is shared by the
// warehouse's services, so it is attributed to its primary service.
export interface UsageRow extends GroupTotals {
  date: string;
  service: string;
  serviceId: string | null;
  entityType: string;
  entityName: string;
  total: number;
  locked: boolean;
  own: boolean;
}

export function toUsageRows(records: UsageRecord[], services: CloudService[], ownServiceId: string | null): UsageRow[] {
  const nameById = new Map<string, string>();
  const primaryByWarehouse = new Map<string, { id: string; name: string }>();
  for (const r of records) {
    if (r.entityType === 'service') {
      nameById.set(r.entityId, r.entityName);
      if (r.dataWarehouseId && !primaryByWarehouse.has(r.dataWarehouseId)) primaryByWarehouse.set(r.dataWarehouseId, { id: r.entityId, name: r.entityName });
    }
  }
  // Live service list wins: it knows current names and which service is primary
  for (const s of services) {
    nameById.set(s.id, s.name);
    if (s.dataWarehouseId && (s.isPrimary || !primaryByWarehouse.has(s.dataWarehouseId))) primaryByWarehouse.set(s.dataWarehouseId, { id: s.id, name: s.name });
  }
  return records.map(r => {
    const totals = emptyTotals();
    for (const [k, v] of Object.entries(r.metrics)) totals[metricGroup(r.entityType, k)] += v;
    let serviceId = r.serviceId;
    let service = serviceId ? nameById.get(serviceId) || r.entityName : r.entityName;
    if (r.entityType === 'datawarehouse' && r.dataWarehouseId && primaryByWarehouse.has(r.dataWarehouseId)) {
      const p = primaryByWarehouse.get(r.dataWarehouseId)!;
      serviceId = p.id;
      service = p.name;
    }
    return {
      date: r.date,
      service,
      serviceId,
      entityType: r.entityType,
      entityName: r.entityName,
      ...totals,
      total: r.totalCHC,
      locked: r.locked,
      own: !!ownServiceId && serviceId === ownServiceId,
    };
  });
}

// Filters shared by every tab that shows usage records
export const USAGE_FILTER_FIELDS: ClientFilterField<UsageRow>[] = [
  { field: 'service', label: 'Service' },
  { field: 'entityType', label: 'Entity type' },
  { field: 'scope', label: 'Scope', getValue: r => (r.own ? 'This environment' : 'Other services') },
];

export const usageSearchText = (r: UsageRow) => `${r.service} ${r.entityName} ${r.entityType}`;

export function sumGroups(rows: UsageRow[]): GroupTotals & { total: number } {
  const t = { ...emptyTotals(), total: 0 };
  for (const r of rows) {
    for (const g of METRIC_GROUPS) t[g] += r[g];
    t.total += r.total;
  }
  return t;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);

// Daily totals per metric group with every date in [from, to] present.
export function dailySeries(rows: UsageRow[], from: string, to: string) {
  const byDate = new Map<string, GroupTotals & { total: number }>();
  for (let d = from; d <= to; d = addDays(d, 1)) byDate.set(d, { ...emptyTotals(), total: 0 });
  for (const r of rows) {
    const day = byDate.get(r.date);
    if (!day) continue;
    for (const g of METRIC_GROUPS) day[g] += r[g];
    day.total += r.total;
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, ...v }));
}

export function byService(rows: UsageRow[]) {
  const map = new Map<string, GroupTotals & { service: string; serviceId: string | null; total: number; own: boolean }>();
  for (const r of rows) {
    const cur = map.get(r.service) || { service: r.service, serviceId: r.serviceId, own: r.own, total: 0, ...emptyTotals() };
    for (const g of METRIC_GROUPS) cur[g] += r[g];
    cur.total += r.total;
    map.set(r.service, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

export interface MonthForecast {
  month: string; // YYYY-MM
  daysInMonth: number;
  dayOfMonth: number;
  monthToDate: number;
  // Average of the last 7 complete days, used to project the rest of the month
  dailyRate: number;
  forecast: number;
  // First day the projected cumulative spend passes the budget, if it does this month
  overspendDate: string | null;
  // Cumulative actual and projected spend per day, for the budget chart
  series: { date: string; actual: number | null; projected: number | null }[];
}

export function forecastMonth(rows: UsageRow[], today: string, budget: number | null): MonthForecast {
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayOfMonth = Number(today.slice(8, 10));
  const daily = dailySeries(rows, addDays(today, -7), today);
  const complete = daily.filter(d => d.date < today);
  const dailyRate = complete.length ? complete.reduce((s, d) => s + d.total, 0) / complete.length : 0;

  const monthRows = rows.filter(r => r.date.startsWith(month));
  const monthToDate = monthRows.reduce((s, r) => s + r.total, 0);
  const completed = monthRows.filter(r => r.date < today).reduce((s, r) => s + r.total, 0);
  const remainingDays = daysInMonth - (dayOfMonth - 1);
  const forecast = completed + dailyRate * remainingDays;

  const series: MonthForecast['series'] = [];
  const perDay = dailySeries(monthRows, `${month}-01`, `${month}-${String(daysInMonth).padStart(2, '0')}`);
  let cum = 0;
  let overspendDate: string | null = null;
  for (const d of perDay) {
    if (d.date < today) {
      cum += d.total;
      series.push({ date: d.date, actual: cum, projected: null });
    } else {
      // Bridge the lines on the last actual point, then project at the daily rate
      if (series.length && series[series.length - 1].projected === null) series[series.length - 1].projected = cum;
      cum += dailyRate;
      series.push({ date: d.date, actual: null, projected: cum });
    }
    if (budget && !overspendDate && cum > budget) overspendDate = d.date;
  }
  return { month, daysInMonth, dayOfMonth, monthToDate, dailyRate, forecast, overspendDate, series };
}

// Same shape as forecastMonth for a fixed monthly cost (self-managed servers
// cost the same every day), so the Budget tab works for both deployments.
export function flatMonthForecast(monthly: number, today: string, budget: number | null): MonthForecast {
  const month = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayOfMonth = Number(today.slice(8, 10));
  const dailyRate = monthly / daysInMonth;
  const series: MonthForecast['series'] = [];
  let overspendDate: string | null = null;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const cum = dailyRate * d;
    series.push({ date, actual: d <= dayOfMonth ? cum : null, projected: d >= dayOfMonth ? cum : null });
    if (budget && !overspendDate && cum > budget) overspendDate = date;
  }
  return { month, daysInMonth, dayOfMonth, monthToDate: dailyRate * dayOfMonth, dailyRate, forecast: monthly, overspendDate, series };
}
