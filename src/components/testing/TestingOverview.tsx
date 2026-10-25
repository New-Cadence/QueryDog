// Overview tab of Testing > Query Performance: headline numbers, runs over
// the chosen window, the slowest queries and the ones whose last run failed.
import { useEffect, useMemo, useState } from 'react';
import { BarChart, Bar, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { bucketFloor, bucketLabel, bucketTimes, type TimeWindow } from '../../hooks/useTimeWindow';
import { FileCode, Timer, Activity, AlertTriangle, VolumeX, Layers, CheckCircle2 } from 'lucide-react';
import { Panel, StatCard, ToolbarButton, EmptyState } from '../ui';
import { formatDuration } from '../../utils/formatters';
import { useIsLightMode } from '../../hooks/useTheme';
import { CHART_COLORS } from '../uiTokens';
import { SeverityPill } from '../checks/cells';
import type { Severity } from '../checks/model';

export interface OverviewQuery {
  filename: string;
  title?: string;
  category?: string;
  severity?: Severity;
  avgRunTime: number | null;
  lastDuration: number | null;
  runCount: number;
}

// One stored run (server/db.js runs table)
interface StoredRun { check_id: string; started_at: string; status: 'ok' | 'warn' | 'fail' | 'error'; duration_ms: number | null }

export function TestingOverview<T extends OverviewQuery>({ queries, win, onZoom, failed, silenced, onView, onOpenChecks }: {
  queries: T[];
  // Window and grouping from the page's time bar
  win: TimeWindow;
  onZoom: (bucketStart: number) => void;
  // Last-run errors by filename
  failed: Record<string, string>;
  silenced: (q: T) => boolean;
  onView: (q: T) => void;
  onOpenChecks: () => void;
}) {
  const isLight = useIsLightMode();
  const grid = isLight ? '#e5e7eb' : '#374151';
  const tick = isLight ? '#6b7280' : '#9ca3af';

  const run = queries.filter(q => q.runCount > 0);
  const runs = run.reduce((s, q) => s + q.runCount, 0);
  const avg = run.length ? run.reduce((s, q) => s + (q.avgRunTime ?? 0), 0) / run.length : null;
  const failing = queries.filter(q => failed[q.filename] !== undefined);
  const categories = new Set(queries.map(q => q.category || 'Uncategorised'));

  // Runs in the window, refetched when it moves or a query has run since
  const [storedRuns, setStoredRuns] = useState<StoredRun[]>([]);
  const latestRun = queries.map(q => (q as OverviewQuery & { lastRunTime?: string | null }).lastRunTime ?? '').sort().at(-1) ?? '';
  useEffect(() => {
    const params = new URLSearchParams({ kind: 'performance', since: new Date(win.start).toISOString(), limit: '20000' });
    fetch(`/api/runs?${params}`)
      .then(r => (r.ok ? r.json() : { runs: [] }))
      .then(d => setStoredRuns(d.runs || []))
      .catch(() => setStoredRuns([]));
  }, [win.start, latestRun]);

  // Runs per bucket (ok / error) and their average duration, for the filtered queries
  const { overTime, bucket } = useMemo(() => {
    const names = new Set(queries.map(q => q.filename));
    const { times, bucket } = bucketTimes(win.start, win.end, win.bucket);
    const index = new Map(times.map((t, n) => [t, n]));
    const rows = times.map(t => ({ t, ok: 0, error: 0, total: 0, sumMs: 0, avg: null as number | null }));
    for (const r of storedRuns) {
      const ms = new Date(r.started_at).getTime();
      if (!names.has(r.check_id) || ms < win.start || ms > win.end) continue;
      const row = rows[index.get(bucketFloor(ms, bucket)) ?? -1];
      if (!row) continue;
      if (r.status === 'error') row.error++;
      else { row.ok++; row.sumMs += r.duration_ms ?? 0; }
    }
    for (const row of rows) {
      row.total = row.ok + row.error;
      row.avg = row.ok ? row.sumMs / row.ok : null;
    }
    return { overTime: rows, bucket };
  }, [storedRuns, queries, win.start, win.end, win.bucket]);
  const stacked = win.chartType === 'stacked-bar' || win.chartType === 'stacked-line';
  const asLines = win.chartType === 'line' || win.chartType === 'stacked-line';
  // Non-stacked charts show one total series rather than overlapping ok/error
  const series = stacked ? [{ key: 'ok', color: CHART_COLORS[1] }, { key: 'error', color: CHART_COLORS[4] }] : [{ key: 'total', color: CHART_COLORS[1] }];

  const slowest = [...run].sort((a, b) => (b.avgRunTime ?? 0) - (a.avgRunTime ?? 0)).slice(0, 15);
  const chart = slowest.map(q => ({ name: q.title || q.filename.replace(/\.sql$/, ''), avg: q.avgRunTime ?? 0 }));

  return (
    <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
      <div className="grid grid-cols-6 gap-3 shrink-0">
        <StatCard label="Queries" icon={FileCode} value={queries.length} />
        <StatCard label="Categories" icon={Layers} value={categories.size} />
        <StatCard label="Runs" icon={Activity} value={runs.toLocaleString()} />
        <StatCard label="Avg run time" icon={Timer} value={avg === null ? '-' : formatDuration(avg)} />
        <StatCard label="Failing" icon={AlertTriangle} value={failing.length} tone={failing.length ? 'red' : 'default'} />
        <StatCard label="Silenced" icon={VolumeX} value={queries.filter(silenced).length} />
      </div>
      <Panel title={`Runs per ${bucket}`} className={`h-64 shrink-0 ${bucket !== 'minute' ? 'cursor-pointer' : ''}`} bodyClassName="p-0">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={overTime} margin={{ top: 15, right: 5, left: 5, bottom: 5 }}
            onClick={e => { const row = overTime[Number(e?.activeTooltipIndex)]; if (row) onZoom(row.t); }}>
            <CartesianGrid strokeDasharray="3 3" stroke={grid} />
            <XAxis dataKey="t" tickFormatter={t => bucketLabel(Number(t), bucket)} minTickGap={20} tick={{ fontSize: 9, fill: tick }} stroke={grid} />
            <YAxis yAxisId="runs" width={30} allowDecimals={false} tick={{ fontSize: 9, fill: tick }} stroke={grid} />
            <YAxis yAxisId="ms" width={50} orientation="right" tick={{ fontSize: 9, fill: tick }} stroke={grid} tickFormatter={v => formatDuration(Number(v))} />
            <Tooltip contentStyle={{ backgroundColor: isLight ? '#fff' : '#1f2937', border: `1px solid ${grid}`, fontSize: 11 }}
              labelFormatter={t => bucketLabel(Number(t), bucket)}
              formatter={(v, name) => (name === 'avg' ? [formatDuration(Number(v)), 'avg run time'] : [v, name])} />
            <Legend wrapperStyle={{ fontSize: 11 }} formatter={n => (n === 'avg' ? 'avg run time' : n === 'total' ? 'runs' : n)} />
            {series.map(sr => (asLines
              ? <Line key={sr.key} yAxisId="runs" type="monotone" dataKey={sr.key} stroke={sr.color} dot={false} isAnimationActive={false} />
              : <Bar key={sr.key} yAxisId="runs" dataKey={sr.key} stackId={stacked ? 'a' : undefined} fill={sr.color} isAnimationActive={false} />))}
            <Line yAxisId="ms" dataKey="avg" stroke={CHART_COLORS[0]} strokeWidth={2} connectNulls dot={{ r: 2 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>
      <div className="grid grid-cols-3 gap-3 shrink-0">
        <Panel title="Slowest queries (average run time)" className="col-span-2 h-80" bodyClassName="p-0">
          {chart.length === 0 ? (
            <EmptyState compact title="No runs" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} layout="vertical" margin={{ top: 10, right: 15, left: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={grid} />
                <XAxis type="number" tick={{ fontSize: 9, fill: tick }} tickFormatter={v => formatDuration(Number(v))} />
                <YAxis type="category" dataKey="name" width={220} interval={0} tick={{ fontSize: 10, fill: tick }} />
                <Tooltip contentStyle={{ backgroundColor: isLight ? '#fff' : '#1f2937', border: `1px solid ${grid}`, fontSize: 11 }}
                  formatter={v => [formatDuration(Number(v)), 'avg']} />
                <Bar dataKey="avg" fill={CHART_COLORS[0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Panel>
        <Panel title={`Failing queries (${failing.length})`} className="h-80" actions={<ToolbarButton onClick={onOpenChecks}>All checks</ToolbarButton>}
          bodyClassName="divide-y divide-gray-800 overflow-y-auto">
          {failing.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-500 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-green-400" />No failing queries
            </div>
          ) : failing.map(q => (
            <button key={q.filename} onClick={() => onView(q)} className="w-full px-3 py-2 text-left hover:bg-gray-800/60">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-white truncate">{q.filename}</span>
                <SeverityPill severity={q.severity || 'info'} />
              </div>
              <div className="text-[11px] text-red-400 truncate" title={failed[q.filename]}>{failed[q.filename]}</div>
            </button>
          ))}
        </Panel>
      </div>
    </div>
  );
}
