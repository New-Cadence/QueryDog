// Date range, chart type and bucket shared by the Cost tabs, mirroring the
// Observability time range bar. ClickHouse Cloud bills per UTC day, so a day
// is the finest granularity; weeks and months are rolled up from days.
import type { ChartKind } from '../uiTokens';
import { addDays, METRIC_GROUPS, type GroupTotals } from './usage';
import { formatDate, formatDayMonth, formatMonthYear } from '../../utils/formatters';

export type CostPreset = 'mtd' | 'lastMonth' | '7' | '30' | '90' | '180';
export type CostChartType = ChartKind;
export type CostBucket = 'day' | 'week' | 'month';

export interface CostRange {
  from: string; // YYYY-MM-DD, inclusive
  to: string;
  preset: CostPreset | null;
}

export interface CostView {
  range: CostRange;
  chartType: CostChartType;
  bucket: CostBucket;
}

// The server caps one usage request at 186 days
export const MAX_RANGE_DAYS = 186;

export const PRESETS: { id: CostPreset; label: string; title: string }[] = [
  { id: 'mtd', label: 'MTD', title: 'Month to date' },
  { id: 'lastMonth', label: 'Last month', title: 'The previous calendar month' },
  { id: '7', label: '7d', title: 'Last 7 days' },
  { id: '30', label: '30d', title: 'Last 30 days' },
  { id: '90', label: '90d', title: 'Last 90 days' },
  { id: '180', label: '6mo', title: 'Last 180 days' },
];

export const earliestDate = (today: string) => addDays(today, -(MAX_RANGE_DAYS - 1));

export function presetRange(preset: CostPreset, today: string): CostRange {
  if (preset === 'mtd') return { from: `${today.slice(0, 7)}-01`, to: today, preset };
  if (preset === 'lastMonth') {
    const lastDay = addDays(`${today.slice(0, 7)}-01`, -1);
    return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay, preset };
  }
  return { from: addDays(today, -(Number(preset) - 1)), to: today, preset };
}

export const rangeDays = (r: Pick<CostRange, 'from' | 'to'>) =>
  Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86400000) + 1;

export function rangeLabel(r: CostRange): string {
  const p = r.preset && PRESETS.find(x => x.id === r.preset);
  return p ? p.title : `${r.from} to ${r.to}`;
}

// The bucket a day falls in: the day itself, the Monday of its week, or the 1st of its month
export function bucketStart(date: string, bucket: CostBucket): string {
  if (bucket === 'day') return date;
  if (bucket === 'month') return `${date.slice(0, 7)}-01`;
  const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

export function bucketTick(key: string, bucket: CostBucket): string {
  return bucket === 'month' ? formatMonthYear(key) : formatDayMonth(key);
}

export function bucketTitle(key: string, bucket: CostBucket): string {
  if (bucket === 'day') return formatDate(key);
  if (bucket === 'week') return `Week of ${formatDate(key)}`;
  return formatMonthYear(key);
}

// Rolls a daily series up into buckets, summing every numeric key
export function bucketSeries<T extends { date: string }>(daily: T[], bucket: CostBucket): T[] {
  if (bucket === 'day') return daily;
  const out = new Map<string, T>();
  for (const d of daily) {
    const key = bucketStart(d.date, bucket);
    const cur = out.get(key);
    if (!cur) { out.set(key, { ...d, date: key }); continue; }
    const acc = cur as Record<string, unknown>;
    for (const [k, v] of Object.entries(d)) if (typeof v === 'number') acc[k] = ((acc[k] as number) || 0) + v;
  }
  return [...out.values()];
}

export const CATEGORY_KEYS: readonly (keyof GroupTotals)[] = METRIC_GROUPS;
