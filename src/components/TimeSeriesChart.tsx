// A bucketed time series drawn as the chart type picked in a TimeRangeBar:
// stacked or total bars, stacked or total lines. Clicking a bucket calls
// onBucketClick so the page can zoom into it.
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { useIsLightMode } from '../hooks/useTheme';
import { CHART_COLORS, type ChartKind } from './uiTokens';

export interface Series {
  key: string;
  color: string;
}

const MARGIN = { top: 15, right: 15, left: 5, bottom: 5 };

export function TimeSeriesChart<T extends { t: number; label: string }>({
  data,
  series,
  chartType,
  onBucketClick,
  valueFormatter = v => v.toLocaleString(),
  totalLabel = 'Total',
}: {
  data: T[];
  series: Series[];
  chartType: ChartKind;
  onBucketClick?: (index: number) => void;
  valueFormatter?: (v: number) => string;
  totalLabel?: string;
}) {
  const isLight = useIsLightMode();
  const grid = isLight ? '#e5e7eb' : '#374151';
  const tick = isLight ? '#6b7280' : '#9ca3af';
  const text = isLight ? '#111827' : '#ffffff';
  const tooltip = { backgroundColor: isLight ? '#ffffff' : '#1f2937', border: `1px solid ${grid}`, borderRadius: '4px', fontSize: '11px' };

  const stacked = chartType === 'stacked-bar' || chartType === 'stacked-line';
  // Non-stacked types show one total series
  const shown = stacked || series.length === 1 ? series : [{ key: '__total', color: CHART_COLORS[0] }];
  const rows = shown[0]?.key === '__total'
    ? data.map(d => ({ ...d, __total: series.reduce((s, x) => s + (Number((d as Record<string, unknown>)[x.key]) || 0), 0) }))
    : data;
  const name = (k: string) => (k === '__total' ? totalLabel : k);
  // Keyed on the timestamp: labels can repeat (e.g. the hour a DST change repeats)
  const labelOf = new Map(data.map(d => [d.t, d.label]));
  const fmt = (t: unknown) => labelOf.get(Number(t)) ?? String(t);
  const onClick = (e: { activeTooltipIndex?: number | string | null } | null) => {
    const i = Number(e?.activeTooltipIndex);
    if (onBucketClick && Number.isInteger(i)) onBucketClick(i);
  };

  const axes = <>
    <CartesianGrid strokeDasharray="3 3" stroke={grid} />
    <XAxis dataKey="t" tickFormatter={fmt} minTickGap={20} tick={{ fontSize: 9, fill: tick }} axisLine={{ stroke: grid }} tickLine={{ stroke: grid }} />
    <YAxis width={45} allowDecimals={false} tick={{ fontSize: 9, fill: tick }} axisLine={{ stroke: grid }} tickLine={{ stroke: grid }} tickFormatter={v => valueFormatter(Number(v))} />
    <Tooltip contentStyle={tooltip} itemStyle={{ color: text }} labelStyle={{ color: text }} labelFormatter={fmt} formatter={(v, n) => [valueFormatter(Number(v)), name(String(n))]} />
    {shown.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} formatter={name} />}
  </>;

  return (
    <ResponsiveContainer width="100%" height="100%">
      {chartType === 'line' || chartType === 'stacked-line' ? (
        <AreaChart data={rows} margin={MARGIN} onClick={onClick}>
          {axes}
          {shown.map(s => <Area key={s.key} type="monotone" dataKey={s.key} stackId={stacked ? 'a' : undefined} stroke={s.color} fill={s.color} fillOpacity={0.3} isAnimationActive={false} />)}
        </AreaChart>
      ) : (
        <BarChart data={rows} margin={MARGIN} onClick={onClick}>
          {axes}
          {shown.map(s => <Bar key={s.key} dataKey={s.key} stackId={stacked ? 'a' : undefined} fill={s.color} fillOpacity={0.85} isAnimationActive={false} />)}
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}
