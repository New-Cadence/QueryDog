import { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef } from 'ag-grid-community';
import { ComposedChart, Area, Line, LineChart, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from 'recharts';
import { Zap, Users, Timer, Gauge, AlertTriangle, TrendingUp, CheckCircle2, XCircle, ListChecks } from 'lucide-react';
import { useGridTheme } from '../../hooks/useTheme';
import { formatNumber } from '../../utils/formatters';
import { Panel, StatCard, Pill, EmptyState } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { SOURCE_LABEL, fmtMs } from './model';
import type { QueryResult, RunSummary } from './model';
import type { RunView } from './useSimulation';
import { axisStroke, axisTick, gridStroke, legendStyle, tooltipStyle } from './chartStyle';
import { GRID_OVERLAYS } from '../gridOverlays';

const MAX_QUERY_LINES = 8;

const msCol = (headerName: string, field: keyof QueryResult, color = '#86efac'): ColDef<QueryResult> => ({
  headerName, field, width: 85, type: 'numericColumn', valueFormatter: p => fmtMs(p.value), cellStyle: { color },
});

export function LiveDashboard({ view, running, summary, visible }: {
  view: RunView | null;
  running: boolean;
  summary: RunSummary | null;
  // Per-query rows left after the toolbar filters; charts follow the same subset
  visible: QueryResult[];
}) {
  const gridTheme = useGridTheme();
  const scenario = view?.scenario;
  const latest = view?.series[view.series.length - 1];
  const filtered = !!view && visible.length !== view.results.length;

  // When filters hide some queries, chart only the visible ones (per-query p95 lines)
  const visibleIdx = useMemo(() => {
    const names = new Set(visible.map(r => r.name));
    return view ? view.results.map((r, i) => (names.has(r.name) ? i : -1)).filter(i => i >= 0) : [];
  }, [view, visible]);

  const throughput = useMemo(() => {
    if (!view) return [];
    if (!filtered) return view.series;
    return view.series.map((p, i) => ({
      ...p,
      qps: visibleIdx.reduce((s, j) => s + view.byQuery[i][j].n, 0),
      errors: visibleIdx.reduce((s, j) => s + view.byQuery[i][j].errors, 0),
    }));
  }, [view, filtered, visibleIdx]);

  const lineIdx = useMemo(() => visibleIdx.slice(0, MAX_QUERY_LINES), [visibleIdx]);
  const perQueryLatency = useMemo(() => {
    if (!view || !filtered) return [];
    return view.series.map((p, i) => Object.fromEntries([['t', p.t], ...lineIdx.map(j => [view.results[j].name, view.byQuery[i][j].p95])]));
  }, [view, filtered, lineIdx]);

  const columns = useMemo((): ColDef<QueryResult>[] => [
    { headerName: 'Query', field: 'name', flex: 1, minWidth: 180, cellStyle: { color: '#f3f4f6' }, tooltipField: 'sql' },
    {
      headerName: 'Baseline', field: 'source', width: 100,
      cellRenderer: (p: { value: QueryResult['source'] }) => <Pill tone={SOURCE_LABEL[p.value].tone}>{SOURCE_LABEL[p.value].label}</Pill>,
    },
    { headerName: 'Executions', field: 'executions', width: 100, type: 'numericColumn', valueFormatter: p => formatNumber(p.value) },
    msCol('Avg', 'avgMs'),
    msCol('p50', 'p50'),
    {
      ...msCol('p95', 'p95'),
      cellStyle: p => ({ color: p.data && p.data.p95TargetMs !== null && p.value > p.data.p95TargetMs ? '#f87171' : '#86efac' }),
    },
    msCol('p99', 'p99', '#fbbf24'),
    msCol('Max', 'maxMs', '#d1d5db'),
    { headerName: 'p95 SLO', field: 'p95TargetMs', width: 85, type: 'numericColumn', valueFormatter: p => (p.value === null ? '—' : fmtMs(p.value)) },
    { headerName: 'Errors', field: 'errors', width: 80, type: 'numericColumn', cellStyle: p => ({ color: p.value > 0 ? '#f87171' : '#9ca3af' }) },
    {
      headerName: 'Error %', field: 'errorPct', width: 85, type: 'numericColumn', valueFormatter: p => `${p.value.toFixed(2)}%`,
      cellStyle: p => ({ color: p.data && p.data.errorBudgetPct !== null && p.value > p.data.errorBudgetPct ? '#f87171' : '#9ca3af' }),
    },
    { headerName: 'Err budget', field: 'errorBudgetPct', width: 90, type: 'numericColumn', valueFormatter: p => (p.value === null ? '—' : `${p.value}%`) },
    {
      headerName: 'SLO', field: 'slo', width: 95,
      cellRenderer: (p: { value: QueryResult['slo'] }) =>
        p.value === 'none' ? <span className="text-gray-500">—</span> : p.value === 'met' ? <Pill tone="green">met</Pill> : <Pill tone="red">breached</Pill>,
    },
  ], []);

  if (!view || !scenario) {
    return (
      <Panel className="flex-1">
        <EmptyState icon={Zap} title="Configure a scenario and press Start test">
          Virtual users run the selected query mix following the chosen load pattern. The load is simulated in your browser,
          shaped by each query's real latency where it has been recorded. Finished runs are kept in History.
        </EmptyState>
      </Panel>
    );
  }

  const { totals } = view;
  const p95Breach = totals.p95 > scenario.p95ThresholdMs;
  const errBreach = totals.errorPct > scenario.errorThresholdPct;

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden min-w-0">
      <div className="grid grid-cols-6 gap-3 shrink-0">
        <StatCard label="Virtual Users" icon={Users} value={latest?.vus ?? 0} sub={`of ${scenario.virtualUsers}`} />
        <StatCard label="Throughput" icon={Zap} value={`${latest?.qps ?? 0} qps`} tone="blue" sub={`avg ${Math.round(totals.executions / Math.max(1, view.t))} qps`} />
        <StatCard label="p50 (run)" icon={Timer} value={fmtMs(totals.p50)} tone="green" sub={`last second ${fmtMs(latest?.p50 ?? 0)}`} />
        <StatCard label="p95 (run)" icon={Gauge} value={fmtMs(totals.p95)} tone={p95Breach ? 'red' : 'green'} sub={`threshold ${fmtMs(scenario.p95ThresholdMs)}`} />
        <StatCard label="Queries" icon={TrendingUp} value={formatNumber(totals.executions)} sub={`${view.t}s of ${scenario.durationSec}s`} />
        <StatCard label="Error Rate" icon={AlertTriangle} value={`${totals.errorPct.toFixed(2)}%`} tone={errBreach ? 'red' : 'default'} sub={`${formatNumber(totals.errors)} failed · limit ${scenario.errorThresholdPct}%`} />
      </div>

      {summary && !running && <Verdict summary={summary} />}

      <div className="grid grid-cols-2 gap-3 h-56 shrink-0">
        <Panel title={filtered ? `Throughput, ${visible.length} filtered queries` : 'Throughput & virtual users'} icon={Zap} bodyClassName="p-2">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={throughput}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis dataKey="t" tick={axisTick} stroke={axisStroke} unit="s" />
              <YAxis yAxisId="l" tick={axisTick} stroke={axisStroke} />
              <YAxis yAxisId="r" orientation="right" tick={axisTick} stroke={axisStroke} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={legendStyle} />
              <Area yAxisId="l" type="monotone" dataKey="qps" name="QPS" stroke={CHART_COLORS[0]} fill={CHART_COLORS[0]} fillOpacity={0.25} isAnimationActive={false} />
              <Line yAxisId="l" type="monotone" dataKey="errors" name="Errors/s" stroke={CHART_COLORS[4]} dot={false} isAnimationActive={false} />
              <Line yAxisId="r" type="stepAfter" dataKey="vus" name="VUs" stroke={CHART_COLORS[3]} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title={filtered ? `p95 by query${visibleIdx.length > MAX_QUERY_LINES ? ` (first ${MAX_QUERY_LINES})` : ''}` : 'Latency percentiles (per second)'} icon={Timer} bodyClassName="p-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={filtered ? perQueryLatency : view.series}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis dataKey="t" tick={axisTick} stroke={axisStroke} unit="s" />
              <YAxis tick={axisTick} stroke={axisStroke} unit="ms" />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={legendStyle} />
              <ReferenceLine y={scenario.p95ThresholdMs} stroke={CHART_COLORS[4]} strokeDasharray="4 4" />
              {filtered
                ? lineIdx.map((j, k) => (
                  <Line key={j} type="monotone" dataKey={view.results[j].name} stroke={CHART_COLORS[k % CHART_COLORS.length]} dot={false} isAnimationActive={false} />
                ))
                : [
                  <Line key="p50" type="monotone" dataKey="p50" stroke={CHART_COLORS[1]} dot={false} isAnimationActive={false} />,
                  <Line key="p95" type="monotone" dataKey="p95" stroke={CHART_COLORS[2]} dot={false} isAnimationActive={false} />,
                  <Line key="p99" type="monotone" dataKey="p99" stroke={CHART_COLORS[4]} dot={false} isAnimationActive={false} />,
                ]}
            </LineChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Per-query results" icon={ListChecks} className="flex-1" bodyClassName="">
        <AgGridReact<QueryResult> {...GRID_OVERLAYS} theme={gridTheme} rowData={visible} columnDefs={columns} suppressCellFocus tooltipShowDelay={400}
          getRowId={p => p.data.name} defaultColDef={{ resizable: true, sortable: true, suppressMovable: true }} />
      </Panel>
    </div>
  );
}

function Verdict({ summary }: { summary: RunSummary }) {
  return (
    <div className={`shrink-0 rounded-lg border px-3 py-2 text-xs ${summary.passed ? 'border-green-800 bg-green-900/20' : 'border-red-800 bg-red-900/20'}`}>
      <div className="flex items-center gap-2">
        {summary.passed ? <Pill tone="green"><CheckCircle2 className="w-3 h-3" />PASS</Pill> : <Pill tone="red"><XCircle className="w-3 h-3" />FAIL</Pill>}
        <span className="text-gray-300">
          {summary.status === 'stopped' ? `Stopped after ${summary.durationSec}s` : `Completed ${summary.durationSec}s`} · {formatNumber(summary.totalQueries)} simulated queries ·
          {' '}{summary.passed ? 'all thresholds and SLOs met' : `${summary.breaches.length} breach${summary.breaches.length === 1 ? '' : 'es'}`}
        </span>
      </div>
      {summary.breaches.length > 0 && (
        <ul className="mt-1.5 ml-1 space-y-0.5 text-red-300">
          {summary.breaches.map(b => <li key={b}>• {b}</li>)}
        </ul>
      )}
    </div>
  );
}
