import { useEffect, useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Activity } from 'lucide-react';
import { EmptyState, Panel, StatCard, LoadingState } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { useGridTheme, useIsLightMode } from '../../hooks/useTheme';
import { bucketFloor, bucketLabel, bucketTimes, useTimeWindow } from '../../hooks/useTimeWindow';
import { TimeRangeBar } from '../TimeRangeBar';
import { formatDateTime, formatNumber } from '../../utils/formatters';
import { type TableUsage, type TableUsageDetail, fetchTableUsage, gridDefaults } from './api';
import { GRID_OVERLAYS } from '../gridOverlays';

type UserRow = NonNullable<TableUsageDetail['users']>[number];
type ColumnRow = NonNullable<TableUsageDetail['columns']>[number];

const userCols: ColDef<UserRow>[] = [
  { field: 'user', headerName: 'User', flex: 1 },
  { field: 'queries', headerName: 'Queries', width: 100, type: 'rightAligned', valueFormatter: p => formatNumber(p.value) },
  { field: 'last_queried', headerName: 'Last queried', width: 175, valueFormatter: p => formatDateTime(p.value) },
];

const columnCols: ColDef<ColumnRow>[] = [
  { field: 'column', headerName: 'Column', flex: 1 },
  { field: 'filtered', headerName: 'Filtered by', width: 110, type: 'rightAligned', headerTooltip: 'Queries where the column name appears after WHERE (approximate)', valueFormatter: p => formatNumber(p.value) },
  { field: 'reads', headerName: 'Read by', width: 100, type: 'rightAligned', headerTooltip: 'Queries that read the column (query_log.columns)', valueFormatter: p => formatNumber(p.value) },
];

export function UsageTab({ database, table, summary, unused }: { database: string; table: string; summary: TableUsage | null; unused: boolean }) {
  const gridTheme = useGridTheme();
  const isLight = useIsLightMode();
  const cc = { grid: isLight ? '#e5e7eb' : '#374151', tick: isLight ? '#6b7280' : '#9ca3af', tooltipBg: isLight ? '#ffffff' : '#1f2937' };
  const win = useTimeWindow('10080');
  const [detail, setDetail] = useState<TableUsageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Minute buckets need minute data; anything coarser is built from hours
  const grain = win.bucket === 'minute' ? 'minute' : 'hour';
  useEffect(() => {
    let cancelled = false;
    fetchTableUsage(database, table, { start: win.start, end: win.end, grain })
      .then(d => { if (!cancelled) { setDetail(d); setError(null); } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load usage'); });
    return () => { cancelled = true; };
  }, [database, table, win.start, win.end, grain]);

  // Queries per bucket across the whole window, zero-filled
  const { chartData, bucket } = useMemo(() => {
    const { times, bucket } = bucketTimes(win.start, win.end, win.bucket);
    const index = new Map(times.map((t, n) => [t, n]));
    const rows = times.map(t => ({ t, queries: 0 }));
    for (const p of detail?.series || []) {
      const row = rows[index.get(bucketFloor(Number(p.t) * 1000, bucket)) ?? -1];
      if (row) row.queries += Number(p.queries);
    }
    return { chartData: rows, bucket };
  }, [detail, win.start, win.end, win.bucket]);
  const asLine = win.chartType === 'line' || win.chartType === 'stacked-line';
  const onChartClick = (e: { activeTooltipIndex?: number | string | null } | null) => {
    const row = chartData[Number(e?.activeTooltipIndex)];
    if (row) win.zoomTo(row.t);
  };

  if (error) return <div className="p-3 text-xs text-red-400">{error}</div>;
  if (!detail) {
    return (
      <LoadingState label="Loading usage…" />
    );
  }
  if (!detail.available) {
    return (
      <EmptyState icon={Activity} title="system.query_log is not available">
        Usage insights are computed from the query log. Enable <code className="text-gray-400">query_log</code> in the server config to see them.
      </EmptyState>
    );
  }

  const kinds = (detail.kinds || []).map(k => `${k.kind || 'Other'}: ${formatNumber(k.queries)}`).join(' · ');
  // Totals for the chosen window (older servers only send the fixed summary)
  const overall = detail.overall;
  return (
    <div className="h-full flex flex-col gap-3 overflow-y-auto">
      <div className="shrink-0"><TimeRangeBar {...win.barProps} /></div>
      <div className="grid grid-cols-4 gap-3 shrink-0">
        <StatCard label="Queries in window" value={formatNumber(overall ? Number(overall.queries) : summary?.queries ?? 0)} sub={kinds || undefined} />
        <StatCard label="Distinct users" value={formatNumber(overall ? Number(overall.users) : summary?.users ?? 0)} />
        <StatCard label="Last queried" value={overall?.queries ? formatDateTime(overall.last_queried) : summary ? formatDateTime(summary.last_queried) : 'Never'} />
        <StatCard label="Status" value={unused ? 'Unused' : summary ? 'Active' : 'Not queried'} tone={unused ? 'yellow' : summary ? 'green' : 'default'}
          sub={unused ? `No queries in ${detail.days} days` : undefined} />
      </div>
      <Panel title={`Queries per ${bucket}`} className={`h-48 shrink-0 ${bucket !== 'minute' ? 'cursor-pointer' : ''}`} bodyClassName="p-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 15, right: 15, left: 5, bottom: 5 }} onClick={onChartClick}>
            <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} />
            <XAxis dataKey="t" tickFormatter={t => bucketLabel(Number(t), bucket)} minTickGap={20} tick={{ fill: cc.tick, fontSize: 9 }} stroke={cc.grid} />
            <YAxis tick={{ fill: cc.tick, fontSize: 9 }} width={40} stroke={cc.grid} allowDecimals={false} tickFormatter={v => formatNumber(v)} />
            <Tooltip contentStyle={{ backgroundColor: cc.tooltipBg, border: `1px solid ${cc.grid}`, fontSize: 11 }} labelFormatter={t => bucketLabel(Number(t), bucket)} />
            {asLine
              ? <Line type="monotone" dataKey="queries" name="Queries" stroke={CHART_COLORS[0]} dot={false} isAnimationActive={false} />
              : <Bar dataKey="queries" name="Queries" fill={CHART_COLORS[0]} isAnimationActive={false} />}
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>
      <div className="grid grid-cols-2 gap-3 min-h-[260px] flex-1">
        <Panel title="Top users" bodyClassName="">
          <AgGridReact<UserRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={detail.users} columnDefs={userCols} defaultColDef={gridDefaults} suppressCellFocus />
        </Panel>
        <Panel title="Most-filtered columns" bodyClassName="">
          <AgGridReact<ColumnRow> {...GRID_OVERLAYS} theme={gridTheme} rowData={detail.columns} columnDefs={columnCols} defaultColDef={gridDefaults} suppressCellFocus tooltipShowDelay={300} />
        </Panel>
      </div>
    </div>
  );
}
