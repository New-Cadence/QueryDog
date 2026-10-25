// Overview: overall quality score, pass/fail counts, results over a chosen
// window (from the stored run history), the worst datasets, dimension scores
// and the rules failing right now. The filter bar narrows all of it.
import { useEffect, useMemo, useState } from 'react';
import { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Gauge, CheckCircle2, XCircle, AlertTriangle, Database, ShieldCheck } from 'lucide-react';
import { EmptyState, PageToolbar, Panel, Pill, StatCard, ToolbarButton, ToolbarSearch } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { formatNumber } from '../../utils/formatters';
import { useClientFilters } from '../../hooks/useClientFilters';
import { useIsLightMode } from '../../hooks/useTheme';
import { bucketFloor, bucketLabel, bucketTimes, useTimeWindow } from '../../hooks/useTimeWindow';
import { ClientFilterPanel } from '../ClientFilterPanel';
import { TimeRangeBar } from '../TimeRangeBar';
import {
  buildDatasets, isBinaryRule, formatAgo, formatPct, meanCompliance, qualityScore, ruleTarget, RULE_TYPES, scoreTone, severityTone,
  ruleFields, ruleSearchText,
  type DqActions, type DqState, type Severity,
} from './model';
import { ComplianceBar } from './widgets';

const severityRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

// One stored run (server/db.js runs table)
interface StoredRun { check_id: string; started_at: string; status: 'ok' | 'fail' | 'error' }

export function OverviewTab({ state, actions, onOpenTab }: { state: DqState; actions: DqActions; onOpenTab: (tab: 'rules' | 'datasets') => void }) {
  const { filters, setFilter, clearAll, search, setSearch, filtered: rules, activeCount } = useClientFilters(state.rules, ruleFields, ruleSearchText);
  const win = useTimeWindow('20160');
  const isLight = useIsLightMode();
  const cc = { grid: isLight ? '#e5e7eb' : '#374151', tick: isLight ? '#6b7280' : '#9ca3af', tooltipBg: isLight ? '#ffffff' : '#1f2937' };
  const [now] = useState(() => Date.now());
  const evaluated = rules.filter(r => r.lastRun);
  const passing = evaluated.filter(r => r.lastRun!.status === 'pass');
  const failing = evaluated.filter(r => r.lastRun!.status === 'fail');
  const erroring = evaluated.filter(r => r.lastRun!.status === 'error');
  const score = qualityScore(rules);
  const compliance = meanCompliance(rules);
  const datasets = useMemo(() => buildDatasets(rules, null, false), [rules]);
  const lastRun = evaluated.map(r => r.lastRun!.time).sort().at(-1) || null;

  // Runs in the window, refetched when the window moves or new results arrive
  const [runs, setRuns] = useState<StoredRun[]>([]);
  const latestRun = state.rules.map(r => r.lastRun?.time ?? '').sort().at(-1) ?? '';
  useEffect(() => {
    const params = new URLSearchParams({ kind: 'dataquality', environment: state.environment, since: new Date(win.start).toISOString(), limit: '20000' });
    fetch(`/api/runs?${params}`)
      .then(r => (r.ok ? r.json() : { runs: [] }))
      .then(d => setRuns(d.runs || []))
      .catch(() => setRuns([]));
  }, [state.environment, win.start, latestRun]);

  // Pass / fail / error per bucket for the filtered checks, plus the share passing
  const { chartData, bucket } = useMemo(() => {
    const ids = new Set(rules.map(r => r.id));
    const { times, bucket } = bucketTimes(win.start, win.end, win.bucket);
    const index = new Map(times.map((t, n) => [t, n]));
    const rows = times.map(t => ({ t, pass: 0, fail: 0, error: 0, score: null as number | null }));
    for (const run of runs) {
      const ms = new Date(run.started_at).getTime();
      if (!ids.has(run.check_id) || ms < win.start || ms > win.end) continue;
      const row = rows[index.get(bucketFloor(ms, bucket)) ?? -1];
      if (row) row[run.status === 'ok' ? 'pass' : run.status] += 1;
    }
    for (const row of rows) {
      const total = row.pass + row.fail + row.error;
      row.score = total ? (row.pass / total) * 100 : null;
    }
    return { chartData: rows, bucket };
  }, [runs, rules, win.start, win.end, win.bucket]);
  const stacked = win.chartType === 'stacked-bar' || win.chartType === 'stacked-line';
  const asLines = win.chartType === 'line' || win.chartType === 'stacked-line';
  const onChartClick = (e: { activeTooltipIndex?: number | string | null } | null) => {
    const row = chartData[Number(e?.activeTooltipIndex)];
    if (row) win.zoomTo(row.t);
  };

  const worst = datasets.filter(d => d.score !== null).sort((a, b) => (a.score! - b.score!) || b.fail - a.fail).slice(0, 8);

  const failingSorted = [...failing, ...erroring].sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] || (a.lastRun!.compliance ?? 0) - (b.lastRun!.compliance ?? 0));

  if (!state.rules.length) {
    return (
      <EmptyState icon={ShieldCheck} title="No data quality checks" />
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
    <PageToolbar
      left={<>
        <ClientFilterPanel rows={state.rules} fields={ruleFields} filters={filters} onChange={setFilter} onClearAll={clearAll} />
        <TimeRangeBar {...win.barProps} />
        <ToolbarSearch value={search} onChange={setSearch} placeholder="Search checks..." />
      </>}
      right={<>
        <span className="text-xs text-gray-400"><span className="text-white font-medium">{rules.length}</span>{rules.length !== state.rules.length && ` of ${state.rules.length}`} checks</span>
        {activeCount > 0 && <span className="text-xs text-blue-400">{activeCount} filter{activeCount > 1 ? 's' : ''} active</span>}
      </>}
    />
    <div className="flex-1 overflow-y-auto px-1.5 pt-3 pb-4 flex flex-col gap-3">
      <div className="grid grid-cols-6 gap-3 shrink-0">
        <StatCard label="Quality score" icon={Gauge} value={formatPct(score, 1)} tone={scoreTone(score)}
          sub="severity-weighted checks passing" title="Critical checks count 3x, warnings 2x, info 1x" />
        <StatCard label="Row compliance" icon={ShieldCheck} value={formatPct(compliance, 2)} tone={scoreTone(compliance)} sub="mean share of rows passing" />
        <StatCard label="Passing" icon={CheckCircle2} value={passing.length} tone={passing.length ? 'green' : 'default'} sub={`of ${evaluated.length} evaluated`} />
        <StatCard label="Failing" icon={XCircle} value={failing.length} tone={failing.length ? 'red' : 'default'}
          sub={`${failing.filter(r => r.severity === 'critical').length} critical`} />
        <StatCard label="Errors / not run" icon={AlertTriangle} value={`${erroring.length} / ${rules.length - evaluated.length}`} tone={erroring.length ? 'yellow' : 'default'} />
        <StatCard label="Datasets" icon={Database} value={datasets.length} sub={`last run ${formatAgo(lastRun, now)}`} />
      </div>

      <div className="grid grid-cols-3 gap-3 h-64 shrink-0">
        <Panel title={`Results per ${bucket}`} className={`col-span-2 ${bucket !== 'minute' ? 'cursor-pointer' : ''}`} bodyClassName="p-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 15, right: 5, left: 5, bottom: 5 }} onClick={onChartClick}>
              <CartesianGrid strokeDasharray="3 3" stroke={cc.grid} />
              <XAxis dataKey="t" tickFormatter={t => bucketLabel(Number(t), bucket)} minTickGap={20} tick={{ fill: cc.tick, fontSize: 9 }} stroke={cc.grid} />
              <YAxis yAxisId="rules" width={30} allowDecimals={false} tick={{ fill: cc.tick, fontSize: 9 }} stroke={cc.grid} />
              <YAxis yAxisId="score" width={40} orientation="right" domain={[0, 100]} tick={{ fill: cc.tick, fontSize: 9 }} stroke={cc.grid} tickFormatter={v => `${v}%`} />
              <Tooltip contentStyle={{ backgroundColor: cc.tooltipBg, border: `1px solid ${cc.grid}`, fontSize: 11 }} labelFormatter={t => bucketLabel(Number(t), bucket)}
                formatter={(v, name) => (name === 'score' ? [formatPct(v as number, 1), '% passing'] : [v, name])} />
              <Legend wrapperStyle={{ fontSize: 11 }} formatter={n => (n === 'score' ? '% passing' : n)} />
              {(['pass', 'fail', 'error'] as const).map((key, i) => {
                const color = [CHART_COLORS[1], CHART_COLORS[4], CHART_COLORS[2]][i];
                return asLines
                  ? <Line key={key} yAxisId="rules" type="monotone" dataKey={key} stroke={color} dot={false} isAnimationActive={false} />
                  : <Bar key={key} yAxisId="rules" dataKey={key} stackId={stacked ? 'a' : undefined} fill={color} isAnimationActive={false} />;
              })}
              <Line yAxisId="score" dataKey="score" stroke={CHART_COLORS[0]} strokeWidth={2} connectNulls dot={{ r: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
        <Panel title="Lowest scoring datasets" actions={<ToolbarButton onClick={() => onOpenTab('datasets')}>All datasets</ToolbarButton>}
          bodyClassName="p-3 space-y-2 overflow-y-auto">
          {worst.length === 0 && <div className="text-xs text-gray-500">Run the checks to score datasets.</div>}
          {worst.map(d => (
            <button key={d.key} onClick={() => actions.openDataset(d.database, d.table)} className="block w-full text-left group">
              <div className="flex justify-between text-[11px]">
                <span className="font-mono text-gray-300 truncate group-hover:text-blue-400">{d.key}</span>
                <span className={d.fail ? 'text-red-400' : 'text-gray-400'}>{formatPct(d.score, 0)}{d.fail ? ` · ${d.fail} failing` : ''}</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded mt-0.5">
                <div className={`h-full rounded ${d.score! >= 95 ? 'bg-green-500' : d.score! >= 80 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${Math.max(2, d.score!)}%` }} />
              </div>
            </button>
          ))}
        </Panel>
      </div>

      <Panel title={`Failing checks (${failingSorted.length})`} actions={<ToolbarButton onClick={() => onOpenTab('rules')}>All checks</ToolbarButton>}
        bodyClassName="divide-y divide-gray-800">
        {failingSorted.length === 0 ? (
          <div className="px-3 py-4 text-xs text-gray-500 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-400" />
            {evaluated.length ? 'Every evaluated check is passing' : 'No checks have run yet: use Run all to evaluate them'}
          </div>
        ) : failingSorted.map(r => {
          const Icon = RULE_TYPES[r.type].icon;
          const run = r.lastRun!;
          return (
            <button key={r.id} onClick={() => actions.openRule(r.id)} className="w-full px-3 py-2 flex items-center gap-3 hover:bg-gray-800/60 text-left">
              <Icon className={`w-3.5 h-3.5 shrink-0 ${run.status === 'error' ? 'text-yellow-400' : 'text-red-400'}`} />
              <span className="text-xs text-white truncate">{r.name}</span>
              <span className="text-[11px] font-mono text-gray-500 truncate">{r.database}.{r.table}{ruleTarget(r) ? `.${ruleTarget(r)}` : ''}</span>
              <Pill tone={severityTone[r.severity]}>{r.severity}</Pill>
              {run.status === 'error' && <Pill tone="yellow">error</Pill>}
              <span className="ml-auto flex items-center gap-3 text-[11px] text-gray-500 shrink-0">
                {run.status === 'error'
                  ? <span className="truncate max-w-[360px] text-yellow-400" title={run.error || ''}>{run.error}</span>
                  : run.detail && isBinaryRule(r)
                    ? <span className="truncate max-w-[360px]">{run.detail}</span>
                    : <span>{formatNumber(run.failing)} of {formatNumber(run.total)} rows</span>}
                {run.status !== 'error' && <ComplianceBar value={run.compliance} width="w-16" />}
                <span>{formatAgo(run.time, now)}</span>
              </span>
            </button>
          );
        })}
      </Panel>
    </div>
    </div>
  );
}
