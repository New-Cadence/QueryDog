import { useState } from 'react';
import type { ReactNode } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { GitCompare, CheckCircle2, XCircle, LineChart as LineIcon } from 'lucide-react';
import { formatNumber, formatDateTime } from '../../utils/formatters';
import { Panel, Pill, EmptyState } from '../ui';
import { CHART_COLORS } from '../uiTokens';
import { fmtMs } from './model';
import type { RunSummary, TickPoint } from './model';
import { axisStroke, axisTick, gridStroke, legendStyle, tooltipStyle } from './chartStyle';

type Metric = 'p50' | 'p95' | 'p99' | 'qps' | 'vus' | 'errors';
const METRICS: { id: Metric; label: string; unit?: string }[] = [
  { id: 'p95', label: 'p95', unit: 'ms' },
  { id: 'p50', label: 'p50', unit: 'ms' },
  { id: 'p99', label: 'p99', unit: 'ms' },
  { id: 'qps', label: 'QPS' },
  { id: 'vus', label: 'VUs' },
  { id: 'errors', label: 'Errors/s' },
];

// Numeric rows: which direction is better, used to highlight the best run and deltas vs the first
const NUMERIC: { label: string; value: (r: RunSummary) => number; fmt: (v: number) => string; better: 'high' | 'low' }[] = [
  { label: 'Avg throughput', value: r => r.avgQps, fmt: v => `${formatNumber(v)} qps`, better: 'high' },
  { label: 'Peak VUs', value: r => r.peakVus, fmt: v => String(v), better: 'high' },
  { label: 'Queries', value: r => r.totalQueries, fmt: v => formatNumber(v), better: 'high' },
  { label: 'p50', value: r => r.p50, fmt: fmtMs, better: 'low' },
  { label: 'p95', value: r => r.p95, fmt: fmtMs, better: 'low' },
  { label: 'p99', value: r => r.p99, fmt: fmtMs, better: 'low' },
  { label: 'Error %', value: r => r.errorPct, fmt: v => `${v}%`, better: 'low' },
];

export function CompareView({ runs }: { runs: RunSummary[] }) {
  const [metric, setMetric] = useState<Metric>('p95');

  if (runs.length < 2) {
    return (
      <Panel className="flex-1">
        <EmptyState icon={GitCompare} title="Select two or more runs in History to compare them">
          Tick the checkbox next to each run. Their headline numbers are shown side by side here, with their per-second curves overlaid.
        </EmptyState>
      </Panel>
    );
  }

  const label = (r: RunSummary, i: number) => `#${i + 1} ${r.scenario}`;
  const unit = METRICS.find(m => m.id === metric)?.unit;

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden">
      <Panel title={`Overlay: ${METRICS.find(m => m.id === metric)?.label} over time`} icon={LineIcon} className="h-72 shrink-0" bodyClassName="p-2"
        actions={
          <div className="flex gap-1">
            {METRICS.map(m => (
              <button key={m.id} type="button" onClick={() => setMetric(m.id)}
                className={`px-2 py-0.5 rounded text-[10px] border ${metric === m.id ? 'bg-blue-600 border-blue-500 text-white' : 'bg-gray-800 border-gray-600 text-gray-400 hover:text-white'}`}>
                {m.label}
              </button>
            ))}
          </div>
        }>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} tick={axisTick} stroke={axisStroke} unit="s" allowDuplicatedCategory={false} />
            <YAxis tick={axisTick} stroke={axisStroke} unit={unit} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={v => `${v}s`} />
            <Legend wrapperStyle={legendStyle} />
            {runs.map((r, i) => (
              <Line key={r.id} data={r.series} dataKey={(p: TickPoint) => p[metric]} name={label(r, i)} type="monotone"
                stroke={CHART_COLORS[i % CHART_COLORS.length]} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Side by side" icon={GitCompare} className="flex-1" bodyClassName="overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="border-b border-gray-700 text-[11px] text-gray-400">
              <th className="text-left font-medium px-3 py-2 w-40">Metric</th>
              {runs.map((r, i) => (
                <th key={r.id} className="text-right font-medium px-3 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
                    <span className="text-gray-200">{label(r, i)}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label="Result" cells={runs.map(r => (
              r.passed ? <Pill tone="green"><CheckCircle2 className="w-3 h-3" />PASS</Pill> : <Pill tone="red"><XCircle className="w-3 h-3" />FAIL</Pill>
            ))} />
            <Row label="Started" cells={runs.map(r => formatDateTime(r.startedAt))} />
            <Row label="Pattern / status" cells={runs.map(r => `${r.pattern} · ${r.status}`)} />
            <Row label="Duration" cells={runs.map(r => `${r.durationSec}s`)} />
            <Row label="Thresholds" cells={runs.map(r => `p95 ${fmtMs(r.p95ThresholdMs)} · err ${r.errorThresholdPct}%`)} />
            {NUMERIC.map(n => {
              const values = runs.map(n.value);
              const best = n.better === 'high' ? Math.max(...values) : Math.min(...values);
              return (
                <Row key={n.label} label={n.label} cells={values.map((v, i) => {
                    const base = values[0];
                    const delta = i > 0 && base !== 0 ? ((v - base) / base) * 100 : null;
                    const improved = delta !== null && (n.better === 'high' ? delta > 0 : delta < 0);
                    return (
                      <span className={v === best ? 'text-green-400 font-medium' : 'text-gray-200'}>
                        {n.fmt(v)}
                        {delta !== null && Math.abs(delta) >= 0.5 && (
                          <span className={`ml-1.5 text-[10px] ${improved ? 'text-green-500' : 'text-red-400'}`}>{delta > 0 ? '+' : ''}{delta.toFixed(0)}%</span>
                        )}
                      </span>
                    );
                  })} />
              );
            })}
            <Row label="Breaches" cells={runs.map(r => (
              r.breaches.length ? <span className="text-red-300 whitespace-pre-line text-[11px]">{r.breaches.join('\n')}</span> : <span className="text-gray-500">none</span>
            ))} />
          </tbody>
        </table>
        <div className="px-3 py-2 text-[10px] text-gray-500">Deltas are relative to run #1. Best value per row in green. All runs are browser simulations.</div>
      </Panel>
    </div>
  );
}

function Row({ label, cells }: { label: string; cells: ReactNode[] }) {
  return (
    <tr className="border-b border-gray-800">
      <td className="px-3 py-1.5 text-gray-400 align-top">{label}</td>
      {cells.map((c, i) => <td key={i} className="px-3 py-1.5 text-right align-top">{c}</td>)}
    </tr>
  );
}
