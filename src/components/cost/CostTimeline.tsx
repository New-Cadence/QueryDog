// The Cost page's equivalent of the Observability time range bar and timeline
// chart: From / To dates, quick ranges, chart type and bucket, and a chart with
// category / service tabs. Clicking a bar zooms the range into that bucket.
import { useMemo, useState } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Layers, Server, CircleDollarSign } from 'lucide-react';
import { useIsLightMode } from '../../hooks/useTheme';
import { CHART_COLORS, CHART_TYPE_CHOICES, type Choice } from '../uiTokens';
import { TimeRangeBar } from '../TimeRangeBar';
import { LoadingState } from '../ui';
import { money, useCost } from './costContext';
import {
  bucketSeries, bucketStart, bucketTick, bucketTitle, earliestDate, presetRange, PRESETS,
  type CostBucket,
} from './costRange';
import { addDays, dailySeries, METRIC_GROUPS, type UsageRow } from './usage';

const MAX_SERVICE_SERIES = 7;

const QUICK = PRESETS.map(p => ({ value: p.id, label: p.label, title: p.title }));
const BUCKETS: Choice<CostBucket>[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

// `datesOnly` hides chart type and bucket on tabs without a timeline
export function CostRangeSelector({ datesOnly = false }: { datesOnly?: boolean }) {
  const { view, setView, today } = useCost();
  const { range } = view;
  const earliest = earliestDate(today);
  return (
    <TimeRangeBar
      inputType="date"
      from={range.from}
      to={range.to}
      min={earliest}
      max={today}
      onChange={(from, to) => {
        const f = from < earliest ? earliest : from;
        const t = to > today ? today : to;
        setView({ ...view, range: f <= t ? { from: f, to: t, preset: null } : { from: t, to: f, preset: null } });
      }}
      quickRanges={QUICK}
      activeQuick={range.preset}
      onQuick={id => setView({ ...view, range: presetRange(id, today) })}
      chartType={datesOnly ? undefined : view.chartType}
      chartTypes={CHART_TYPE_CHOICES}
      onChartType={chartType => setView({ ...view, chartType })}
      bucket={datesOnly ? undefined : view.bucket}
      buckets={BUCKETS}
      onBucket={bucket => setView({ ...view, bucket })}
      bucketTitle="ClickHouse Cloud bills per UTC day, so a day is the finest granularity"
    />
  );
}

export type CostSplit = 'category' | 'service' | 'total';
type Split = CostSplit;

const SPLITS: { id: Split; label: string; icon: typeof Layers }[] = [
  { id: 'category', label: 'By Category', icon: Layers },
  { id: 'service', label: 'By Service', icon: Server },
  { id: 'total', label: 'Total', icon: CircleDollarSign },
];

// Spend over the selected range. `rows` should already be filtered (filters
// and search), but not yet restricted to the range. Pass split/onSplitChange
// to drive other panels (e.g. a breakdown underneath) from the same tabs.
export function CostTimelineChart({ rows, loading, split: splitProp, onSplitChange }: {
  rows: UsageRow[]; loading?: boolean; split?: Split; onSplitChange?: (split: Split) => void;
}) {
  const { view, setView } = useCost();
  const { range, bucket, chartType } = view;
  const [ownSplit, setOwnSplit] = useState<Split>('category');
  const split = splitProp ?? ownSplit;
  const setSplit = onSplitChange ?? setOwnSplit;
  const isLight = useIsLightMode();
  const cc = {
    grid: isLight ? '#e5e7eb' : '#374151',
    tick: isLight ? '#6b7280' : '#9ca3af',
    tooltip: { backgroundColor: isLight ? '#ffffff' : '#1f2937', border: `1px solid ${isLight ? '#e5e7eb' : '#374151'}`, borderRadius: '4px', fontSize: '11px' },
    text: isLight ? '#111827' : '#ffffff',
  };

  const { data, series } = useMemo(() => {
    const inRange = rows.filter(r => r.date >= range.from && r.date <= range.to);
    if (split !== 'service') {
      const daily = dailySeries(inRange, range.from, range.to);
      const s = split === 'category'
        ? METRIC_GROUPS.map((g, i) => ({ key: g as string, color: CHART_COLORS[i] }))
        : [{ key: 'total', color: '#fbbf24' }];
      return { data: bucketSeries(daily, bucket), series: s };
    }
    // Largest services get their own series, the rest are grouped as "Other"
    const totals = new Map<string, number>();
    for (const r of inRange) totals.set(r.service, (totals.get(r.service) || 0) + r.total);
    const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SERVICE_SERIES).map(([s]) => s);
    const keys = totals.size > top.length ? [...top, 'Other'] : top;
    const byDate = new Map<string, Record<string, number | string>>();
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) byDate.set(d, Object.fromEntries([['date', d], ...keys.map(k => [k, 0])]));
    for (const r of inRange) {
      const day = byDate.get(r.date);
      const k = top.includes(r.service) ? r.service : 'Other';
      if (day) day[k] = (day[k] as number) + r.total;
    }
    const daily = [...byDate.values()] as unknown as { date: string }[];
    return { data: bucketSeries(daily, bucket), series: keys.map((k, i) => ({ key: k, color: k === 'Other' ? '#6b7280' : CHART_COLORS[i % CHART_COLORS.length] })) };
  }, [rows, range.from, range.to, bucket, split]);

  // Clicking a bucket zooms the range into it
  const zoomTo = (key?: string) => {
    if (!key || bucket === 'day') return;
    const end = bucket === 'week' ? addDays(key, 6) : addDays(bucketStart(addDays(key, 32), 'month'), -1);
    setView({ ...view, bucket: bucket === 'month' ? 'week' : 'day', range: { from: key < range.from ? range.from : key, to: end > range.to ? range.to : end, preset: null } });
  };

  const stacked = chartType === 'stacked-bar' || chartType === 'stacked-line';
  // A non-stacked chart of several series reads best as one total
  const shown = stacked ? series : [{ key: split === 'total' ? 'total' : '__total', color: '#fbbf24' }];
  const chartData = stacked || split === 'total' ? data : data.map(d => ({ ...d, __total: series.reduce((s, x) => s + (((d as Record<string, unknown>)[x.key] as number) || 0), 0) }));
  const nameOf = (k: string) => (k === '__total' || k === 'total' ? 'Total' : k);

  const axes = <>
    <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} />
    <XAxis dataKey="date" tickFormatter={k => bucketTick(k, bucket)} tick={{ fontSize: 9, fill: cc.tick }} axisLine={{ stroke: cc.grid }} tickLine={{ stroke: cc.grid }} minTickGap={16} />
    <YAxis tick={{ fontSize: 9, fill: cc.tick }} axisLine={{ stroke: cc.grid }} tickLine={{ stroke: cc.grid }} width={55} tickFormatter={v => money(v)} />
    <Tooltip contentStyle={cc.tooltip} itemStyle={{ color: cc.text }} labelStyle={{ color: cc.text }}
      labelFormatter={k => bucketTitle(String(k), bucket)} formatter={(v, n) => [money(Number(v), 2), nameOf(String(n))]} />
    {shown.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} formatter={nameOf} />}
  </>;

  return (
    <div className="shrink-0">
      <div className="flex gap-1 border-b border-gray-700 mb-2">
        {SPLITS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setSplit(id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
              split === id ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-300'
            }`}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        ))}
      </div>
      <div className={`h-72 bg-gray-900 border border-gray-700 rounded flex ${bucket !== 'day' ? 'cursor-pointer' : ''}`}>
        {loading ? <LoadingState label="Loading billing data from the ClickHouse Cloud API…" /> : (
          <ResponsiveContainer width="100%" height="100%">
            {chartType === 'bar' || chartType === 'stacked-bar' ? (
              <BarChart data={chartData} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={e => zoomTo(e?.activeLabel as string | undefined)}>
                {axes}
                {shown.map(s => <Bar key={s.key} dataKey={s.key} name={s.key} stackId={stacked ? 'a' : undefined} fill={s.color} />)}
              </BarChart>
            ) : (
              <AreaChart data={chartData} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={e => zoomTo(e?.activeLabel as string | undefined)}>
                {axes}
                {shown.map(s => <Area key={s.key} type="monotone" dataKey={s.key} name={s.key} stackId={stacked ? 'a' : undefined} stroke={s.color} fill={s.color} fillOpacity={stacked ? 0.5 : 0.25} />)}
              </AreaChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
